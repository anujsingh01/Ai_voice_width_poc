// Turns the raw pages saved by scrape.js into a clean, structured catalogue
// (data/catalog.json) that the chat server searches.
//
// For each product it pulls out: name, category, price/MRP/discount, stock,
// every size/colour variant with its own price and stock, key features,
// description, a tidy spec table, warranty and care tips. It drops page
// furniture (menus, review widgets, legal addresses), fixes spacing and
// spelling slips, and removes duplicate pages.
//
//   node scraper/clean.js

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "..", "data");
const RAW = path.join(DATA, "raw");
const INDEX = path.join(DATA, "pages.json");
const OUT = path.join(DATA, "catalog.json");

// Spec rows that are the same on every product or just repeat the title.
const DROP_SPEC = /^(mfg\.?\s*by|manufactured by|marketed by|packed by|importer|customer care|pack size|net quantity|package dimension|product label|a\+ image|more detail)|^(contents?|mrp|svachh)$/i;
// Info pages that aren't useful to a shopper.
const DROP_PAGE = /no-route|enable-cookies|^\/?$|home|sitemap|thank|login|account|careers|trademark/i;

const FIXES = [
  [/\balumunium\b/gi, "Aluminium"],
  [/\baluminum\b/gi, "Aluminium"],
  [/\bstainles steel\b/gi, "Stainless Steel"],
  [/\bnon[\s-]?stick\b/gi, "Non-stick"],
];

export const tidy = (s) => {
  if (!s) return "";
  let t = String(s).replace(/ /g, " ").replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
  for (const [re, to] of FIXES) t = t.replace(re, to);
  return t;
};

// "FOOD-GRADE STAINLESS STEEL" -> "Food-grade stainless steel"
const sentenceCase = (s) => (s === s.toUpperCase() && /[A-Z]{3}/.test(s) ? s.charAt(0) + s.slice(1).toLowerCase() : s);

// "PRESTIGE SVACHH HOB ( PSVH-OZ AI ) 2.0 L" -> "Prestige Svachh Hob (PSVH-OZ AI) 2.0 L"
const KEEP_CAPS = new Set(["SS", "HA", "AI", "LPG", "LP", "OTG", "PSVH", "OZ", "GT", "GTM", "GTMC", "PGL", "BYK", "PRO", "MG", "W", "L", "ML", "LED", "USB", "ISI", "PIC", "PKH", "PDC", "PEBS", "AKH", "UK"]);
const smallWords = new Set(["and", "with", "for", "of", "the", "in", "on", "to", "a", "or"]);
function titleCase(s) {
  if (s !== s.toUpperCase() || !/[A-Z]{4}/.test(s)) return s;
  return s
    .split(/(\s+)/)
    .map((w, i) => {
      if (/\d/.test(w) || /^[^A-Za-z]*$/.test(w)) return w;
      const core = w.replace(/[^A-Za-z-]/g, "");
      if (core.split("-").every((p) => KEEP_CAPS.has(p))) return w;
      const lower = w.toLowerCase();
      if (i > 0 && smallWords.has(lower)) return lower;
      return lower.replace(/(^|[-(/&])([a-z])/g, (_, a, b) => a + b.toUpperCase());
    })
    .join("")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")");
}

const money =(n) => (n == null || isNaN(n) || Number(n) <= 0 ? null : Math.round(Number(n)));
export const rupees = (n) => (n == null ? "" : `₹${n.toLocaleString("en-IN")}`);

// A store-wide GST price notice that some pages put in the key features box.
const NOTICE = /GST|Consequent to reduction|reduction in the MRP|below mentioned categories|^from \d+% to \d+%|^SL No/i;

function featureList($, el) {
  const out = [];
  $(el).find("li").each((_, li) => {
    const strong = tidy($(li).find("strong").first().text()).replace(/:$/, "");
    let text = tidy($(li).text());
    if (strong && text.startsWith(strong)) {
      const rest = text.slice(strong.length).replace(/^[:\s-]+/, "");
      text = rest ? `${sentenceCase(strong)}: ${rest}` : sentenceCase(strong);
    }
    if (text && !NOTICE.test(text)) out.push(text);
  });
  return [...new Set(out)];
}

function specTable($, body) {
  const specs = {};
  $(body).find(".additional-attributes-row, tr").each((_, row) => {
    const label = tidy($(row).find(".label, th").first().text());
    const value = tidy($(row).find(".data, td").first().text());
    if (!label || !value || DROP_SPEC.test(label) || /^n\/?a$|^-$/i.test(value)) return;
    if (!specs[label]) specs[label] = value;
  });
  if (specs["Product Sub Type"] && specs["Product Sub Type"] === specs["Product Type"]) delete specs["Product Sub Type"];
  return specs;
}

// The configurable-product JSON holds each variant's size/colour, SKU, price and stock.
function variantConfig($) {
  let config = null;
  $("script").each((_, s) => {
    const txt = $(s).html() ?? "";
    if (config || !txt.includes('"optionPrices"')) return;
    try {
      const walk = (o) => {
        if (!o || typeof o !== "object") return null;
        if (o.optionPrices && o.attributes) return o;
        for (const v of Object.values(o)) {
          const found = walk(v);
          if (found) return found;
        }
        return null;
      };
      config = walk(JSON.parse(txt));
    } catch {}
  });
  return config;
}

function parseProduct($, url) {
  const main = $(".product-info-main").first();
  const title = titleCase(tidy($('span.base[itemprop="name"]').first().text()) || tidy($('meta[property="og:title"]').attr("content")));
  if (!title) return null;

  let crumbs = [];
  $('script[type="application/ld+json"]').each((_, s) => {
    try {
      const j = JSON.parse($(s).html());
      if (j["@type"] === "BreadcrumbList") crumbs = j.itemListElement.map((i) => tidy(i.item?.name));
    } catch {}
  });

  const price = money(main.find('[data-price-type="finalPrice"]').first().attr("data-price-amount"));
  const mrp = money(main.find('[data-price-type="oldPrice"]').first().attr("data-price-amount"));
  const stockEl = main.find(".stock").first();
  const inStock = stockEl.hasClass("available") || /\bin stock\b/i.test(stockEl.text());

  const keyFeatures = featureList($, $(".product.attibute.key_feature, .product.attribute.key_feature").first());
  const description = tidy($('[id="product.info.description"].content, .custom-description').first().text());

  let specs = {};
  $(".additional-attributes-body").each((_, b) => {
    if (!/child_attribute_/.test($(b).attr("class") ?? "") && !Object.keys(specs).length) specs = specTable($, b);
  });

  // Warranty & care tab: a care list plus a warranty line.
  const wc = $("#warranty_and_care");
  const care = [];
  wc.find("li").each((_, li) => {
    const t = tidy($(li).text());
    if (t) care.push(t);
  });
  const wcText = tidy(wc.text());
  let warranty = wcText.match(/Warranty Instructions\s*(.+?)(?:Care and Instructions|$)/i)?.[1]?.trim() ?? "";
  if (!warranty) warranty = keyFeatures.find((f) => /warranty/i.test(f)) ?? specs.Warranty ?? "";
  if (warranty.length > 500) warranty = warranty.slice(0, 500).replace(/[^.]*$/, "").trim() || warranty.slice(0, 500);

  // Variants (sizes, colours, burner counts…).
  const variants = [];
  const cfg = variantConfig($);
  if (cfg) {
    const attrs = Object.values(cfg.attributes);
    const salable = new Set(Object.values(cfg.salable ?? {}).flatMap((o) => Object.values(o).flat()));
    for (const [pid, opts] of Object.entries(cfg.index ?? {})) {
      const optionIds = Object.values(opts);
      const label = attrs
        .map((a) => a.options.find((o) => optionIds.includes(o.id))?.label)
        .filter(Boolean)
        .map(tidy)
        .join(", ");
      const op = cfg.optionPrices?.[pid];
      const optId = optionIds[0];
      const vSpecs = specTable($, $(`.child_attribute_${optId}`).first());
      const vFeatures = featureList($, $(`.child_feature_${optId}`).first());
      variants.push({
        label,
        pid,
        options: opts, // { attributeId: optionId }, what the store's add-to-cart form needs
        sku: cfg.sku?.[pid] ?? cfg.dynamic?.sku?.[pid]?.value ?? "",
        price: money(op?.finalPrice?.amount),
        mrp: money(op?.oldPrice?.amount),
        inStock: salable.has(pid),
        specs: vSpecs,
        keyFeatures: vFeatures,
        description: tidy($(`.child_description_${optId}`).first().text()),
      });
    }
    variants.sort((a, b) => (parseFloat(a.label) || 0) - (parseFloat(b.label) || 0) || a.label.localeCompare(b.label));
    // The store sometimes files several sizes under one option ("5.5 L and above"):
    // tell them apart by SKU rather than show identical labels.
    const counts = new Map();
    for (const v of variants) counts.set(v.label, (counts.get(v.label) ?? 0) + 1);
    for (const v of variants) if (counts.get(v.label) > 1 && v.sku) v.label += ` (SKU ${v.sku})`;
  }

  const anyInStock = variants.length ? variants.some((v) => v.inStock) : inStock;
  const prices = variants.map((v) => v.price).filter(Boolean);
  const best = prices.length ? Math.min(...prices) : price;
  const bestMrp = variants.find((v) => v.price === best)?.mrp ?? mrp;

  // A configurable product often has no top-level features/specs: use the first variant's.
  const firstWithInfo = variants.find((v) => v.keyFeatures.length || Object.keys(v.specs).length);
  if (!Object.keys(specs).length && firstWithInfo) specs = { ...firstWithInfo.specs };

  // Specs that differ between variants (capacity, dimensions…) belong on the
  // variants only; specs shared by all variants stay on the product once.
  if (variants.length) {
    const keys = new Set(variants.flatMap((v) => Object.keys(v.specs)));
    for (const k of keys) {
      const values = new Set(variants.map((v) => v.specs[k]).filter(Boolean));
      if (values.size > 1) delete specs[k];
      else if (values.size === 1) {
        specs[k] ??= [...values][0];
        for (const v of variants) delete v.specs[k];
      }
    }
  }

  return {
    kind: "product",
    url,
    title,
    productId: $('#product_addtocart_form input[name="product"]').attr("value") ?? "",
    category: crumbs.slice(1, -1).join(" > "),
    sku: tidy(main.find('[itemprop="sku"]').first().text()),
    price: best,
    mrp: bestMrp && bestMrp > (best ?? 0) ? bestMrp : null,
    discountPct: best && bestMrp > best ? Math.round((1 - best / bestMrp) * 100) : 0,
    inStock: anyInStock,
    keyFeatures: keyFeatures.length ? keyFeatures : firstWithInfo?.keyFeatures ?? [],
    description: description || firstWithInfo?.description || "",
    specs,
    variants: variants.map(({ keyFeatures: _k, description: _d, ...v }) => v),
    warranty,
    care: care.slice(0, 12),
    image: (($('meta[property="og:image"]').attr("content") ?? "").split("?")[0]).replace(/^.*\/placeholder\/.*$/, ""), // no "image coming soon" tiles
  };
}

// Long pages (FAQ, policies) are split into ~1500-character chunks at sentence
// ends, so a question only pulls in the part of the page that answers it.
function parsePage($, url) {
  const title = tidy($("title").first().text()).replace(/\s*[|-]\s*TTK Prestige.*$/i, "");
  const main = $("#maincontent").first();
  main.find("script, style, form, nav, .breadcrumbs, .page-title-wrapper, #authenticationPopup, .page.messages").remove();
  // Mobile header links that sit inside the main content.
  const text = tidy(main.text()).replace(/^(Home\s*)?Support\s*Categories\s*Cart\s*Cart\s*Account\s*/i, "");
  if (!title || text.length < 200) return [];
  const chunks = [];
  let cur = "";
  for (const s of text.split(/(?<=[.?!])\s+/)) {
    if (cur && cur.length + s.length > 1500) {
      chunks.push(cur);
      cur = "";
    }
    cur += (cur ? " " : "") + s;
  }
  if (cur) chunks.push(cur);
  return chunks.map((t, i) => ({ kind: "page", url, title: chunks.length > 1 ? `${title} (part ${i + 1})` : title, text: t }));
}

export function buildCatalog() {
  const index = fs.existsSync(INDEX) ? JSON.parse(fs.readFileSync(INDEX, "utf8")) : {};
  const docs = [];
  for (const [url, { kind, file }] of Object.entries(index)) {
    if (kind === "page" && DROP_PAGE.test(new URL(url).pathname)) continue;
    const full = path.join(RAW, file);
    if (!fs.existsSync(full)) continue;
    const $ = cheerio.load(zlib.gunzipSync(fs.readFileSync(full)).toString("utf8"));
    if (kind === "product") {
      const doc = parseProduct($, url);
      if (doc) docs.push(doc);
    } else docs.push(...parsePage($, url));
  }

  // Same product listed under two URLs (often a size picker page plus a
  // single-size page with the same name): keep the in-stock, more complete one.
  const richness = (d) =>
    (d.inStock ? 100 : 0) + (d.keyFeatures?.length ?? 0) + Object.keys(d.specs ?? {}).length + (d.variants?.length ?? 0) * 3 + (d.description ? 5 : 0);
  const byKey = new Map();
  for (const d of docs) {
    const key = d.kind === "product" ? `p:${d.title.toLowerCase()}` : `c:${d.title.toLowerCase()}`;
    const prev = byKey.get(key);
    if (!prev || richness(d) > richness(prev)) byKey.set(key, d);
  }
  const catalog = [...byKey.values()];

  const tmp = OUT + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(catalog, null, 1));
  fs.renameSync(tmp, OUT); // atomic, so the server never reads a half-written file
  return {
    products: catalog.filter((d) => d.kind === "product").length,
    pages: catalog.filter((d) => d.kind === "page").length,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { products, pages } = buildCatalog();
  console.log(`Wrote ${path.relative(process.cwd(), OUT)}: ${products} products, ${pages} info pages`);
}
