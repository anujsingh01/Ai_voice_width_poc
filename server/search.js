// In-memory BM25 search over the cleaned catalogue, so each question only
// sends the few most relevant products to Claude instead of the whole store.
// It understands everyday words ("mixie", "kadai", "chulha", Hindi), budgets
// ("under 5000") and stays fresh: the catalogue reloads when the file changes.

import fs from "node:fs";

const STOP = new Set(
  "a an and are as at be by can do does for from have how i in is it me my of on or show tell that the this to want what which with you your please need any some suggest recommend best good buy looking".split(" "),
);

// Everyday / regional words -> the words the store uses.
const SYNONYMS = {
  mixie: "mixer grinder", mixi: "mixer grinder", mixy: "mixer grinder", grinder: "mixer grinder", juicer: "juicer mixer grinder",
  kadai: "kadai kadhai", kadhai: "kadai kadhai", karahi: "kadai kadhai", wok: "kadai wok",
  chulha: "gas stove", chula: "gas stove", stove: "gas stove", burner: "burner gas stove", hob: "hob hobtop", hobtop: "hob hobtop",
  cooker: "pressure cooker", kukar: "pressure cooker",
  gift: "gift combo set", gifts: "gift combo set", wedding: "gift combo set", shaadi: "gift combo set", tohfa: "gift combo set", housewarming: "gift combo set", tawa: "tawa tava", tava: "tawa tava",
  nonstick: "non-stick", induction: "induction", cooktop: "induction cooktop", chimney: "chimney",
  kettle: "electric kettle", toaster: "toaster", oven: "oven otg", otg: "oven otg", sandwich: "sandwich maker",
  flask: "flask bottle", bottle: "bottle flask", tiffin: "lunch box tiffin", fridge: "refrigerator",
  // Hindi (Devanagari)
  "कुकर": "pressure cooker", "तवा": "tawa", "कढ़ाई": "kadai", "कड़ाही": "kadai", "चूल्हा": "gas stove",
  "मिक्सी": "mixer grinder", "मिक्सर": "mixer grinder", "बर्तन": "cookware", "इंडक्शन": "induction",
};

export const tokenize = (s) =>
  String(s)
    .toLowerCase()
    .replace(/non[\s-]stick/g, "nonstick")
    .replace(/(\d)\s*(l|ltr|litre|liter|litres|liters)\b/g, "$1l")
    // "750 Watt", "750-watt" and "750W" are one search word, as are "24 cm" and "24cm".
    .replace(/(\d)\s*-?\s*(w|watt|watts)\b/g, "$1w")
    .replace(/(\d)\s*(cm|cms|centimeters?|centimetres?)\b/g, "$1cm")
    .split(/[^\p{L}\p{M}\p{N}.]+/u)
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .filter((t) => t && !STOP.has(t));

const PRODUCT_TYPES = [
  "mixer grinder", "wet grinder", "pressure cooker", "gas stove", "hob", "induction cooktop", "chimney", "kitchen hood",
  "tawa", "kadai", "fry pan", "sauce pan", "casserole", "kettle", "toaster", "sandwich maker", "oven", "air fryer",
  "rice cooker", "hand blender", "juicer", "flask", "bottle", "lunch box", "water purifier", "idli", "cookware set",
].map((s) => s.split(" "));

const PEOPLE = /\b(?:family of|for|ke liye)?\s*\d+\s*(?:log|logon|logo|people|persons?|members?|adults?|jan[oe]?)\b|\b(?:for a family of|family of)\s*\d+\b/gi;
// Head count -> the cooker sizes that suit it (litres), best first. The same
// guide is in the assistant's rules, so search and answers agree.
const SIZES_FOR = (n) => (n <= 2 ? [2, 2.5, 3] : n === 3 ? [3, 3.5, 4] : n === 4 ? [5, 4, 3.5] : n <= 6 ? [5.5, 6.5, 7.5, 6] : [7.5, 8, 10, 12]);
// "teen logon", "four people", "चार लोग": number words as well as digits.
const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  ek: 1, do: 2, teen: 3, tin: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, chhah: 6, che: 6, saat: 7, sat: 7, aath: 8, aat: 8, nau: 9, das: 10,
  "एक": 1, "दो": 2, "तीन": 3, "चार": 4, "पांच": 5, "पाँच": 5, "छह": 6, "छः": 6, "सात": 7, "आठ": 8,
};
const NUM = `\\d+|${Object.keys(NUMBER_WORDS).join("|")}`;
const HEADS = new RegExp(`(?:^|[\\s,])(${NUM})\\s*(?:log|logon|logo|logo[ño]|people|persons?|members?|adults?|jan[oe]?|लोग|लोगों|लोगो|सदस्य)(?=$|[\\s,.?!])|family of\\s*(${NUM})\\b`, "iu");
const headCount = (q) => {
  const m = String(q).match(HEADS);
  if (!m) return null;
  const w = (m[1] ?? m[2]).toLowerCase();
  const n = /^\d+$/.test(w) ? Number(w) : NUMBER_WORDS[w];
  return n >= 1 && n <= 20 ? n : null;
};
// Every capacity a product comes in: "5 L", "5.0 L", "5 Litres", variants, specs.
export const capacities = (d) => {
  if (d.kind !== "product") return [];
  const litres = (t) => [...String(t ?? "").matchAll(/(\d+(?:\.\d+)?)\s*(?:l|ltr|litres?|liters?)\b/gi)].map((m) => Number(m[1]));
  // The title is most reliable: the Capacity spec is often a filter bucket
  // ("5.5 L and above") even on a 12 L cooker.
  const fromVariants = d.variants.flatMap((v) => litres(v.label));
  const fromTitle = litres(d.title);
  return fromVariants.length ? [...fromVariants, ...fromTitle] : fromTitle.length ? fromTitle : litres(d.specs?.Capacity);
};

const PART = /\b(gasket|whistle|weight valve|safety valve|safety plug|separator|handle|lid only|spare|knob|lifter|rubber)s?\b/i;

const expand = (tokens) => tokens.flatMap((t) => (SYNONYMS[t] ? [t, ...tokenize(SYNONYMS[t])] : [t]));

// "under 5000", "below ₹3k", "within 2,500", "budget 4000"
export function maxBudget(text) {
  const m = String(text).toLowerCase().match(/(?:under|below|less than|within|upto|up to|max(?:imum)?|budget(?: of| is)?|<)\s*(?:rs\.?|₹|inr)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|thousand)?/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1);
  return n >= 100 ? n : null;
}

const searchText = (d) =>
  d.kind === "product"
    ? [
        d.title, d.title, d.title, d.category, d.category, d.sku,
        ...d.variants.flatMap((v) => [v.label, v.sku, ...Object.values(v.specs)]),
        ...d.keyFeatures, ...Object.entries(d.specs).flat(), d.description,
      ].join(" ")
    : `${d.title} ${d.title} ${d.text}`;

export class ProductIndex {
  constructor(file) {
    this.file = file;
    this.load();
    // Pick up new scrapes without restarting the server.
    fs.watchFile(file, { interval: 5000 }, () => {
      try {
        this.load();
        console.log(`Catalogue reloaded: ${this.size} entries`);
      } catch (err) {
        console.warn(`Catalogue reload failed, keeping the old one: ${err.message}`);
      }
    });
  }

  load() {
    const docs = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : [];
    const tf = [], len = [], df = new Map(), nameTokens = [], caps = [];
    for (const d of docs) {
      nameTokens.push(new Set(tokenize(`${d.title} ${d.category ?? ""}`)));
      caps.push(capacities(d));
      const toks = tokenize(searchText(d));
      const counts = new Map();
      for (const t of toks) counts.set(t, (counts.get(t) ?? 0) + 1);
      for (const t of counts.keys()) df.set(t, (df.get(t) ?? 0) + 1);
      tf.push(counts);
      len.push(toks.length);
    }
    const byUrl = new Map(docs.filter((d) => d.kind === "product").map((d) => [d.url, d]));
    Object.assign(this, { docs, tf, len, df, nameTokens, caps, byUrl, avgLen: len.reduce((a, b) => a + b, 0) / Math.max(1, len.length) });
  }

  product(url) {
    return this.byUrl.get(url) ?? null;
  }

  get size() {
    return this.docs.length;
  }

  // `latest` is the customer's newest message on its own: "cheapest" counts only
  // when that message names a kind of product, so a follow-up like "which one
  // is cheapest?" compares what was already shown instead of searching anew.
  search(query, k = 6, latest = query) {
    // "4 logon ke liye", "family of 4": a head count, not a product spec (the
    // reply still sees it), so it mustn't match "4 Burners".
    const cleaned = String(query).replace(PEOPLE, " ").replace(new RegExp(HEADS.source, "giu"), " ");
    const terms = [...new Set(expand(tokenize(cleaned)))];
    if (!terms.length) return [];
    const wantsCombo = /\b(combo|set|offer|bundle|pack|gift|wedding|shaadi|tohfa|housewarming)s?\b/i.test(query);
    // "sabse sasta mixer", "cheapest kettle": the lowest in-stock prices of that kind, not the best text match.
    const latestTerms = new Set(expand(tokenize(latest)));
    const wantsCheapest = /\b(cheapest|lowest price|least expensive|sabse sasta|sabse sasti|sasta|sasti|budget wala|kam daam)\b/i.test(latest);
    const wantsPart = PART.test(query);
    const N = this.docs.length;
    const k1 = 1.4, b = 0.75;
    const budget = maxBudget(query);
    // The kind of product asked for ("mixer grinder", "kadai") is a common word
    // across the store, so BM25 under-weights it; boost products of that kind.
    const types = PRODUCT_TYPES.filter((ty) => ty.every((t) => terms.includes(t)));
    // "4 logon ke liye cooker": prefer the sizes a family that size uses.
    const people = headCount(query);
    const sizes = people ? SIZES_FOR(people) : null;
    const scored = [];
    for (let i = 0; i < N; i++) {
      let score = 0;
      for (const t of terms) {
        const f = this.tf[i].get(t);
        if (!f) continue;
        const df = this.df.get(t);
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * this.len[i]) / this.avgLen)));
      }
      if (score <= 0) continue;
      const d = this.docs[i];
      if (d.kind === "product") {
        if (types.length && types.some((ty) => ty.every((t) => this.nameTokens[i].has(t)))) score *= 2.5;
        if (budget && d.price) score *= d.price <= budget ? 1.3 : 0.35;
        if (sizes && this.caps[i].length) score *= this.caps[i].some((c) => sizes.includes(c)) ? 2.5 : 0.2;
        if (!d.inStock) score *= d.price ? 0.6 : 0.4; // still findable, but buyable items first
        // Combo packs and spare parts only when asked for: "a cooker" means a cooker.
        if (!wantsCombo && (/\s\+\s|combi(?:nation)? pack|combo/i.test(d.title) || /^Shubhutsav/i.test(d.category))) score *= 0.4;
        if (!wantsPart && (/^Accessories/i.test(d.category) || PART.test(d.title))) score *= 0.3;
      }
      scored.push([score, i]);
    }
    // A follow-up "which one is cheapest?" names no product, so take the kind,
    // size and stove from the chat so far ("cooker", "4 people", "induction").
    const latestTypes = types.filter((ty) => ty.every((t) => latestTerms.has(t)));
    // "I have an induction cooktop" mentions a product too; the one they asked
    // for first is what they're shopping for.
    const order = tokenize(cleaned);
    const firstAt = (ty) => Math.min(...ty.map((t) => order.indexOf(t)).filter((n) => n >= 0), Infinity);
    const cheapTypes = latestTypes.length ? latestTypes : types.slice().sort((a, b) => firstAt(a) - firstAt(b)).slice(0, 1);
    if (wantsCheapest && cheapTypes.length) {
      const litres = [...String(query).matchAll(/(\d+(?:\.\d+)?)\s*(?:l|ltr|litres?|liters?|लीटर)\b/giu)].map((m) => Number(m[1]));
      // For 4 people the size guide says 5 L; 4 L and 3.5 L only rank, they aren't the answer.
      const fits = litres.length ? litres : people === 4 ? [5] : sizes;
      const induction = /induction|इंडक्शन/i.test(query) && !/non[- ]?induction/i.test(query);
      const ofType = scored.filter(([, i]) => {
        const d = this.docs[i];
        const part = /^Accessories/i.test(d.category) || PART.test(d.title);
        if (!(d.kind === "product" && d.inStock && d.price && (wantsPart || !part) && cheapTypes.some((ty) => ty.every((t) => this.nameTokens[i].has(t))))) return false;
        if (!wantsCombo && (/\s\+\s|combi(?:nation)? pack|combo|\d L, \d L/i.test(d.title))) return false;
        // The size asked for must be in stock, not just listed.
        const sized = (d.variants ?? []).filter((v) => !Number.isNaN(parseFloat(v.label)));
        if (fits && sized.length && !sized.some((v) => v.inStock && fits.includes(parseFloat(v.label)))) return false;
        if (fits && !sized.length && this.caps[i].length && !this.caps[i].some((c) => fits.includes(c))) return false;
        if (induction && !inductionOk(d)) return false;
        const about = `${d.title} ${d.specs?.Material ?? ""} ${(d.keyFeatures ?? []).join(" ")}`;
        if (MUST_HAVE.some(([asked, has, not]) => asked.test(query) && (!has.test(about) || not?.test(d.title)))) return false;
        return true;
      });
      if (ofType.length) {
        // The price of the size asked for, not the smallest size on the page.
        const priceOf = (d) => {
          const sized = fits ? (d.variants ?? []).filter((v) => v.inStock && fits.includes(parseFloat(v.label))).map((v) => v.price) : [];
          return sized.length ? Math.min(...sized) : d.price;
        };
        const found = ofType.sort((a, b) => priceOf(this.docs[a[1]]) - priceOf(this.docs[b[1]])).slice(0, k).map(([, i]) => this.docs[i]);
        found.cheapest = true;
        return found;
      }
    }
    scored.sort((a, b) => b[0] - a[0]);
    return scored.slice(0, k).map(([, i]) => this.docs[i]);
  }

  // "Compare Nakshatra Plus and Deluxe Plus": one search finds only the
  // stronger name, so search each side on its own (with the rest of the
  // question, e.g. "cooker 5 litre") and give both sides equal room.
  compare(latest, k = 4) {
    if (!COMPARE.test(latest)) return null;
    const sides = latest
      .replace(COMPARE_LEAD, " ")
      .split(COMPARE_SPLIT)
      .map((s) => s.trim())
      .filter((s) => tokenize(s).some((t) => !BRAND.has(t)));
    if (sides.length < 2) return null;
    const each = Math.max(1, Math.floor(k / sides.length));
    const found = [];
    for (const side of sides.slice(0, 3)) {
      // The model name the customer typed ("deluxe plus") must be in the title,
      // even when that model is out of stock and ranks below similar ones.
      const name = tokenize(side).filter((t) => !BRAND.has(t) && !GENERIC.has(t) && !/^\d/.test(t));
      const pool = [...new Set([...this.search(`${side} ${side} ${latest}`, 40, side), ...this.search(side, 80, side)])].filter((d) => !found.includes(d));
      const i = this.docs.indexOf.bind(this.docs);
      const combo = (d) => !/\b(combo|set|pack)\b/i.test(latest) && /\s\+\s|combi(?:nation)? pack|combo|\d L, \d L/i.test(d.title);
      const named = pool.filter((d) => name.length && name.every((t) => this.nameTokens[i(d)].has(t))).sort((a, b) => combo(a) - combo(b));
      for (const d of (named.length ? named : pool).slice(0, each)) found.push(d);
    }
    return found;
  }
}

// A material or feature the customer asked for, and how a product shows it.
const MUST_HAVE = [
  // Some hard anodised pages list "Stainless Steel" as their material; the title wins.
  [/\b(stainless|steel)\b|स्टील/i, /stainless|\bsteel\b/i, /hard[- ]?anodi|alumin/i],
  [/\balumin(i)?um\b/i, /alumin/i],
  [/hard[- ]?anodi[sz]ed/i, /hard[- ]?anodi/i],
  [/tri[- ]?ply/i, /tri[- ]?ply/i],
  [/auto[- ]?ignition/i, /auto[- ]?ignition/i],
  [/glass[- ]?top/i, /glass/i],
];

// Works on induction: says so in the Base spec or the title, and not "non induction".
export const inductionOk = (d) => {
  const t = `${d.specs?.Base ?? ""} ${d.title}`;
  return /induction/i.test(t) && !/non[- ]?induction/i.test(t);
};

const COMPARE = /\b(compare|comparison|vs\.?|versus|v\/s|difference|differ|better|farak|fark|antar|behtar)\b|तुलना|बेहतर|फर्क/i;
const COMPARE_LEAD = /\b(please|pls|compare|comparison (of|between)|difference between|what is the|what's the|which is better|which one is better|kaunsa better hai|konsa better hai|better|between|the|farak|fark)\b|[?।]/gi;
const COMPARE_SPLIT = /\s+(?:vs\.?|versus|v\/s|or|and|ya|aur|with|compared to)\s+|\s*,\s*/i;
const BRAND = new Set(["prestige", "judge", "ttk", "which", "is", "a", "an"]);
const GENERIC = new Set(["pressure", "cooker", "cookers", "mixer", "grinder", "gas", "stove", "cooktop", "induction", "kettle", "tawa", "kadai", "pan", "litre", "litres", "liter", "l", "ltr", "burner", "one", "model", "the"]);

const inr = (n) => (n ? `₹${n.toLocaleString("en-IN")}` : "");

// Compact, readable card for Claude. Every character here is paid for on
// every message, so long care and warranty text only goes in when asked.
export const wantsDetail = (q) => ({
  care: /\b(clean|wash|care|maint|safe|dishwasher|use|using|instruction|saaf|dhona)/i.test(q),
  warranty: /\b(warrant|guarant|replace|repair|service)/i.test(q),
  size: /\b(size|dimension|fit|height|width|tall|big|small|compact|space|cm|inch|bada|chhota|jagah)/i.test(q),
});

// A pack: "combo", "+ Prestige ...", "4 Pc", or a cooker titled with two sizes ("5 L, 3 L").
const isPack = (d) =>
  /\bcombo\b|\bcombi\b|value pack|starter pack|\+\s*prestige|\b\d+\s*(?:pc|pcs|piece)s?\b/i.test(d.title) ||
  (/^Pressure Cookers/i.test(d.category ?? "") && /\d+(?:\.\d+)?\s*(?:l|ltr|litres?)\s*(?:,|\+|&)\s*\d+(?:\.\d+)?\s*(?:l|ltr|litres?)\b|\d\s*\+\s*\d/i.test(d.title));

export function formatDoc(d, want = {}) {
  if (d.kind !== "product") return `INFO PAGE: ${d.title}\nURL: ${d.url}\n${d.text.slice(0, 1800)}`;
  const lines = [`PRODUCT: ${d.title.slice(0, 140)}`, `URL: ${d.url}`];
  if (d.category) lines.push(`CATEGORY: ${d.category}`);
  // "Popular Plus 5 L, 3 L" is two cookers for one price; say so, or the pack
  // price gets quoted for a single 3 L cooker.
  if (isPack(d)) lines.push("PACK: several items sold together; the price is for the whole pack, not for any one item in it.");
  if (d.variants.length) {
    lines.push("OPTIONS:");
    for (const v of d.variants) {
      const price = v.price ? `${inr(v.price)}${v.mrp > v.price ? ` (MRP ${inr(v.mrp)}, ${Math.round((1 - v.price / v.mrp) * 100)}% off)` : ""}` : "price not listed";
      // A size option's capacity is its label, and dimensions only matter when asked.
      const extra = Object.entries(v.specs)
        .filter(([k, val]) => !SKIP_SPECS.has(k) && !(k === "Capacity" && v.label.includes(val)) && (want.size || !/dimension/i.test(k)))
        .map(([k, val]) => `${k}: ${val}`).join("; ");
      lines.push(`- ${v.label}: ${price}, ${v.inStock ? "in stock" : "out of stock"}${extra ? ` | ${extra}` : ""}`);
    }
  } else {
    lines.push(`PRICE: ${d.price ? `${inr(d.price)}${d.mrp ? ` (MRP ${inr(d.mrp)}, ${d.discountPct}% off)` : ""}` : "not listed"}`);
    lines.push(`AVAILABILITY: ${d.inStock ? "In stock" : "Out of stock"}`);
  }
  if (d.keyFeatures.length) {
    // Gasket pages say "Size Compatibility for the Above models: 4.5, 5, 7 L" on a
    // line of its own; joined to its models it can't be read as applying to all.
    const feats = [];
    for (const f of d.keyFeatures) {
      const sizes = f.match(/^size compatibility for the above models:\s*(.*)$/i);
      if (sizes && feats.length) feats[feats.length - 1] += ` - only in ${sizes[1]}`;
      else feats.push(f);
    }
    const part = /^Accessories/i.test(d.category ?? "") && /gasket|whistle|valve|plug|separator/i.test(d.title);
    lines.push(part ? `FITS ONLY (each line is separate, model - sizes): ${feats.join(" | ")}` : `KEY FEATURES: ${feats.join("; ")}`);
  }
  // Some pages say "Capacity: 1 L" on a 5 L cooker; the size in the name wins.
  const named = [...d.title.matchAll(/(\d+(?:\.\d+)?)\s*(?:l|ltr|litres?|liters?)\b/gi)].map((m) => Number(m[1]));
  const wrongCapacity = (k, v) => k === "Capacity" && named.length && !named.includes(parseFloat(v));
  const specs = Object.entries(d.specs).filter(([k, v]) => !SKIP_SPECS.has(k) && !wrongCapacity(k, v) && (want.size || !/dimension/i.test(k))).map(([k, v]) => `${k}: ${v}`);
  // Gas or induction is the first thing people ask about a cooker or pan; when
  // the page has no Base line, say so plainly rather than leave a gap to guess at.
  // Some pages contradict themselves: "Gas & Induction Compatible" in the name, "Base: Non Induction" in the specs.
  if (/non[- ]?induction/i.test(d.specs.Base ?? "") && /induction compatible|gas\s*(?:&|and)\s*induction/i.test(d.title)) {
    specs.push("NOTE: the name says induction compatible but the Base spec says non induction; tell the customer the page is unclear and to confirm before buying for induction");
  }
  if (!d.specs.Base && /^(Pressure Cookers|Cookware)/i.test(d.category ?? "")) {
    specs.push(inductionOk(d) ? "Base: Induction Compatible (from the product name)" : "Base: not stated on the page (so don't say whether it works on induction)");
  }
  if (specs.length) lines.push(`SPECS: ${specs.join("; ")}`);
  // The description is mostly marketing; its first lines hold what's distinctive.
  if (d.description) lines.push(`ABOUT: ${clip(d.description, want.care || want.warranty ? 400 : 220)}`);
  // Key features usually already say "5 Years Warranty"; the full terms only when asked.
  const warrantyInFeatures = d.keyFeatures.some((f) => /warrant/i.test(f));
  if (d.warranty && (want.warranty || !warrantyInFeatures)) lines.push(`WARRANTY: ${want.warranty ? d.warranty : clip(d.warranty, 160)}`);
  if (want.care && d.care.length) lines.push(`CARE: ${d.care.slice(0, 5).join(" ").slice(0, 700)}`);
  return lines.join("\n");
}

// Specs a shopper never asks about.
const SKIP_SPECS = new Set(["Model Name", "Country Of Origin", "Product Type"]);
// Cut at a sentence end where possible, so Claude never sees half a sentence.
const clip = (t, n) => {
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const end = cut.lastIndexOf(". ");
  return end > n * 0.5 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, "")}…`;
};
