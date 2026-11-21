// Store tools Claude can call while answering, so it isn't limited to the few
// products the first search guessed: it can search again with better words,
// a category, a price range or cheapest-first, and open a product's full page.
// Used by the API tool loop in server.js and, for Demo mode, by mcp.js.

import { formatDoc, capacities, inductionOk, tokenize } from "./search.js";

export const TOOLS = [
  {
    name: "search_products",
    description:
      "Search the Prestige online store's catalogue. Use it whenever the products already shown don't fit what the customer actually wants: a different product type, a feature, a budget, cheapest/most powerful, or to compare. Search again with other words or another category if the results miss. Returns up to `limit` products with price, sizes, stock, key features and specs.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for, in English store words, e.g. 'induction cooktop energy saving', 'stainless steel pressure cooker 5 litre', 'mixer grinder 750W'. Can be empty when a category is given." },
        category: { type: "string", description: "Only products whose category contains this text, from the category list, e.g. 'Induction Cooktops', 'Mixer Grinder', 'Pressure Cookers', 'Gas Stove'." },
        material: { type: "string", enum: ["stainless steel", "aluminium", "hard anodised", "triply", "cast iron", "non-stick", "ceramic", "glass"], description: "Only products of this material." },
        size_litres: { type: "number", description: "Only products available in this size, in litres (cookers, kadais, kettles, rice cookers)." },
        induction: { type: "boolean", description: "true: only products that work on induction; false: only ones that don't say so." },
        min_price: { type: "number", description: "Lowest price in rupees." },
        max_price: { type: "number", description: "Highest price in rupees." },
        in_stock_only: { type: "boolean", description: "Only products that can be bought now. Default true." },
        sort: { type: "string", enum: ["relevance", "price_low_to_high", "price_high_to_low", "discount_high_to_low", "watts_high_to_low", "watts_low_to_high"], description: "Default relevance. discount_high_to_low is for offers, deals and sales (an empty query searches the whole store). Watts sorting is for appliances (most powerful, lowest power draw)." },
        limit: { type: "integer", description: "How many products, 1-10. Default 6." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_product",
    description: "Full details of one product by its URL: every size and price, stock, features, specs, description, warranty terms and care instructions. Use for detailed questions about one product.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "The product's URL from a search result." } },
      required: ["url"],
    },
  },
  {
    name: "store_policy",
    description: "The store's own pages on returns, refunds, cancellation, delivery/shipping, payment, warranty registration, service and FAQs. Use for any question about orders or policies.",
    input_schema: {
      type: "object",
      properties: { topic: { type: "string", description: "e.g. 'return damaged product', 'delivery time', 'cancel order', 'cash on delivery'." } },
      required: ["topic"],
    },
  },
];

// Product categories with how many products each has, for the system prompt,
// so Claude knows what the store sells and the exact names to filter by.
export function categoryList(index) {
  const counts = new Map();
  for (const d of index.docs) if (d.kind === "product" && d.category && !/^Shubhutsav/i.test(d.category)) counts.set(d.category, (counts.get(d.category) ?? 0) + 1);
  return [...counts].sort((a, b) => a[0].localeCompare(b[0])).map(([c, n]) => `${c} (${n})`).join("; ");
}

// Lowest in-stock price, or the price of the size asked for.
const lowest = (d, size) => {
  const vs = (d.variants ?? []).filter((v) => v.inStock && (!size || parseFloat(v.label) === size));
  const ps = (vs.length ? vs.map((v) => v.price) : [d.price]).filter(Boolean);
  return ps.length ? Math.min(...ps) : Infinity;
};
// Motor or heating power in watts, from the specs or the name ("750W", "Wattage: 1600 W").
const watts = (d) => {
  const t = `${Object.entries(d.specs ?? {}).filter(([k]) => /watt|power/i.test(k)).map(([, v]) => v).join(" ")} ${d.title}`;
  const m = t.match(/(\d{3,4})\s*-?\s*(?:w|watts?)\b/i);
  return m ? Number(m[1]) : 0;
};
// How a product shows a material: in its name, Material spec or features. Some
// hard anodised pages list "Stainless Steel" as the material, so the name wins.
const MATERIAL = {
  "stainless steel": [/stainless|\bsteel\b/i, /hard[- ]?anodi|alumin/i],
  aluminium: [/alumin/i],
  "hard anodised": [/hard[- ]?anodi/i],
  triply: [/tri[- ]?ply/i],
  "cast iron": [/cast[- ]?iron/i],
  "non-stick": [/non[- ]?stick/i],
  ceramic: [/ceramic/i],
  glass: [/glass/i],
};
const sizes = (d) => {
  const v = (d.variants ?? []).filter((x) => !Number.isNaN(parseFloat(x.label)));
  return v.length ? v.filter((x) => x.inStock).map((x) => parseFloat(x.label)) : capacities(d);
};
// Words that name a kind of product rather than a model, so "Deluxe Plus
// pressure cooker" leaves the model name "deluxe plus".
const GENERIC = new Set(["prestige", "ttk", "pressure", "cooker", "cookers", "mixer", "grinder", "grinders", "gas", "stove", "stoves", "cooktop", "cooktops", "induction", "kettle", "electric", "tawa", "kadai", "pan", "fry", "litre", "litres", "liter", "l", "ltr", "burner", "burners", "with", "and", "for", "the", "a", "of", "set", "best", "good", "energy", "saving", "cheap", "cheapest", "price"]);
const buyable = (d) => d.inStock || (d.variants ?? []).some((v) => v.inStock);

// Cooker spare parts (gaskets, separators) only show up
// when the customer asks for a part, so "pressure cooker under 800" doesn't
// come back as a list of gaskets.
const PART_WORDS = /gasket|whistle|valve|spare|accessor|part|handle|lid|knob|jar|blade|burner cap|sealing|ring|filter/i;
const NONE = "No products match";
const COOKER_PART = /gasket|cooker separator|spare/i; // categories of cooker spare parts
// Kinds of product. When the words name one ("pressure cooker", "induction
// cooktop"), every result must be that kind, so a loose word match can't
// bring back an OTG for "9 litre pressure cooker".
const KINDS = ["pressure cooker", "induction cooktop", "gas stove", "mixer grinder", "wet grinder", "juicer mixer grinder", "air fryer", "rice cooker", "hand blender", "sandwich maker", "water purifier", "kettle", "toaster", "chimney", "kadai", "tawa", "fry pan", "otg", "oven", "juicer", "idli", "hob", "flask", "bottle", "lunch box", "casserole", "tope", "handi", "cookware set", "wok", "sauce pan", "iron", "vacuum cleaner", "dishwasher", "gasket", "whistle", "safety valve", "knife", "mop", "ladder", "dust bin", "gas lighter", "lighter", "cutter", "barbeque", "dispenser", "cooker separator", "separator"].map((k) => k.split(" "));
const stem = (t) => t.replace(/(es|s)$/, "");
function kindOf(query) {
  const q = tokenize(query).map(stem).join(" ");
  // "gasket for pressure cooker" asks for the gasket: a part beats the product it fits.
  const part = (k) => PART_WORDS.test(k.join(" "));
  return KINDS.filter((k) => ` ${q} `.includes(` ${k.map(stem).join(" ")} `)).sort((a, b) => part(b) - part(a) || b.length - a.length)[0];
}

// A search that comes back empty is retried the way a good salesperson
// would: over budget -> the cheapest without the limit; no such size -> the
// sizes there are (and that size in other models); no such material, stove
// type or stock -> the nearest matches. A NOTE says what was relaxed, so the
// answer can say "nothing under ₹800, the cheapest is...".
function searchWithFallbacks(index, input) {
  input = { ...input };
  const query = String(input.query ?? "");
  // "Deluxe Alpha 8 litre" names a size in the words: use it as a size filter.
  const said = query.match(/(\d+(?:\.\d+)?)\s*-?\s*(?:l|ltr|litres?|liters?)\b/i);
  // Not for parts: a "gasket 5 litre" fits a 5 L cooker; its page lists the models instead.
  if (said && !input.size_litres && !PART_WORDS.test(query)) input.size_litres = Number(said[1]);
  let out = searchProducts(index, input);
  if (!out.startsWith(NONE)) return out;
  const notes = [];
  let cur = input;
  const steps = [
    ["max_price", (i) => `Nothing matches at or under ₹${i.max_price}; the cheapest ones without that limit:`, (i) => ({ ...i, max_price: 0, sort: "price_low_to_high" })],
    ["size_litres", (i) => `Nothing matches in ${i.size_litres} L; the same products in the sizes there are:`, (i) => ({ ...i, size_litres: 0 })],
    ["material", (i) => `Nothing matches in ${i.material}; the nearest matches in other materials:`, (i) => ({ ...i, material: "" })],
    ["induction", (i) => i.induction ? `Nothing like this works on induction. These are the nearest matches, and none of them is for induction (Base: Non Induction, or not stated): say so plainly, never say they work on induction:` : `Nothing matches as a non-induction model; the nearest matches:`, (i) => ({ ...i, induction: undefined })],
    ["min_price", () => `Nothing matches above that price; the nearest matches:`, (i) => ({ ...i, min_price: 0 })],
  ];
  for (const [key, note, relax] of steps) {
    if (!cur[key] && cur[key] !== false) continue;
    notes.push(note(cur));
    const size = key === "size_litres" ? cur.size_litres : 0;
    cur = relax(cur);
    out = searchProducts(index, cur);
    if (out.startsWith(NONE)) continue;
    // A named model without that size: also show that size in other models.
    const kind = tokenize(query).filter((t) => GENERIC.has(t) && !/^(prestige|ttk|best|good|cheap|cheapest|price|with|and|for|the|a|of|set)$/.test(t)).join(" ");
    if (size && kind && kind !== tokenize(query).join(" ")) {
      const other = searchProducts(index, { ...input, query: kind, size_litres: size, limit: 2, max_price: 0 });
      if (!other.startsWith(NONE)) out += `\n\n---\n\nOTHER MODELS IN ${size} L:\n${other}`;
    }
    return `NOTE: ${notes.join(" ")}\n${out}`;
  }
  if (input.in_stock_only !== false) {
    out = searchProducts(index, { ...cur, in_stock_only: false });
    if (!out.startsWith(NONE)) return `NOTE: ${[...notes, "None of these are in stock right now; out-of-stock matches:"].join(" ")}\n${out}`;
  }
  return out;
}

function searchProducts(index, input) {
  {
    const limit = Math.min(10, Math.max(1, Number(input.limit) || 6));
    const query = String(input.query ?? "").trim();
    let found = query ? index.search(query, 400, query) : index.docs;
    // Models made for the USA and Canada (110 V) aren't for Indian kitchens.
    const abroad = /usa|canada|110\s*v/i.test(query);
    found = found.filter((d) => d.kind === "product" && (abroad || !(d.specs?.Voltage === "110" || /usa\s*&\s*canada|110\s*v\s*ac/i.test((d.keyFeatures ?? []).join(" ")))));
    if (!PART_WORDS.test(`${query} ${input.category ?? ""}`)) found = found.filter((d) => !COOKER_PART.test(d.category ?? ""));
    // A model they named comes first, in stock or not, so the answer can say
    // "the Deluxe Plus is out of stock" instead of quietly talking about another.
    const name = tokenize(query).filter((t) => !GENERIC.has(t) && !/^\d/.test(t));
    let named = [];
    if (name.length && (!input.sort || input.sort === "relevance")) {
      named = index.docs.filter((d) => d.kind === "product" && name.every((t) => tokenize(d.title).includes(t)));
      named = found.filter((d) => named.includes(d)).concat(named.filter((d) => !found.includes(d)));
    }
    if (input.category) {
      const want = String(input.category).toLowerCase();
      found = found.filter((d) => (d.category ?? "").toLowerCase().includes(want));
    }
    if (input.in_stock_only !== false) found = found.filter(buyable);
    if (named.length) {
      // "deluxe plus" written together beats "Deluxe Duo Plus".
      const phrase = ` ${name.join(" ")} `;
      const exact = named.filter((d) => ` ${tokenize(d.title).join(" ")} `.includes(phrase));
      const loose = named.filter((d) => !exact.includes(d));
      found = [...exact.filter(buyable), ...exact.filter((d) => !buyable(d)).slice(0, 2), ...loose.filter(buyable), ...found.filter((d) => !named.includes(d))];
    }
    const kind = kindOf(query);
    if (kind) {
      // A cooker's name can say "Gasket Release System"; a part is a part by its category.
      const part = PART_WORDS.test(kind.join(" "));
      const isKind = (d) => {
        if (part && !COOKER_PART.test(d.category ?? "")) return false;
        return ` ${tokenize(`${d.title} ${d.category ?? ""}`).map(stem).join(" ")} `.includes(` ${kind.map(stem).join(" ")} `);
      };
      // Products filed under that kind come before ones that only mention it.
      const want = ` ${kind.map(stem).join(" ")} `;
      const filed = (d) => ` ${tokenize(d.category ?? "").map(stem).join(" ")} `.includes(want);
      const same = found.filter(isKind).sort((a, b) => filed(b) - filed(a));
      // No such part in the store (whistles aren't sold online): say so rather than show cooktops.
      if (same.length || part) found = same;
    }
    if (input.material && MATERIAL[input.material]) {
      const [has, not] = MATERIAL[input.material];
      found = found.filter((d) => has.test(`${d.title} ${d.specs?.Material ?? ""} ${(d.keyFeatures ?? []).join(" ")}`) && !not?.test(d.title));
    }
    if (input.size_litres) found = found.filter((d) => sizes(d).includes(Number(input.size_litres)));
    if (input.induction === true) found = found.filter(inductionOk);
    if (input.induction === false) found = found.filter((d) => !inductionOk(d));
    const size = Number(input.size_litres) || 0;
    if (input.min_price) found = found.filter((d) => lowest(d, size) >= input.min_price);
    if (input.max_price) found = found.filter((d) => lowest(d, size) <= input.max_price);
    if (input.sort === "price_low_to_high") found = [...found].sort((a, b) => lowest(a, size) - lowest(b, size));
    if (input.sort === "price_high_to_low") found = [...found].sort((a, b) => lowest(b, size) - lowest(a, size));
    if (input.sort === "discount_high_to_low") {
      found = found.filter((d) => d.discountPct > 0).sort((a, b) => b.discountPct - a.discountPct);
      // Store-wide offers: the best deal in each kind of product, not five cookers.
      if (!query && !input.category) {
        const seen = new Set();
        input = { ...input, storeWide: true };
        found = found.filter((d) => { const c = d.category ?? ""; return !seen.has(c) && seen.add(c); });
      }
    }
    if (input.sort?.startsWith("watts")) {
      found = found.filter(watts);
      found = [...found].sort((a, b) => (input.sort === "watts_high_to_low" ? watts(b) - watts(a) : watts(a) - watts(b)));
    }
    if (!found.length) return `${NONE}. Try other words, a broader category, or no price filter.`;
    // Facts about the whole line they named ("Svachh") or the whole category,
    // so the answer can say "most, but not all" instead of "all Svachh cookers",
    // and give warranty ranges that are real.
    let line = "";
    const cat = input.category ? String(input.category).toLowerCase() : "";
    let pool = named.length > 3 ? named : !name.length && cat ? index.docs.filter((d) => d.kind === "product") : [];
    if (cat) pool = pool.filter((d) => (d.category ?? "").toLowerCase().includes(cat));
    if (pool.length > 3) {
      const ind = pool.filter(inductionOk).length;
      const years = {};
      for (const d of pool) {
        const m = `${d.title} ${(d.keyFeatures ?? []).join(" ")}`.match(/(\d+)\s*-?\s*y(?:ea)?r?s?\.?\s*(?:product\s*)?warranty/i);
        const k = m ? `${m[1]} years` : "not stated";
        years[k] = (years[k] ?? 0) + 1;
      }
      const label = named.length > 3 ? `"${name.join(" ")}"` : "This category";
      line = `FACTS: ${label} has ${pool.length} products in the store${cat ? ` in ${input.category}` : ""}: ${ind} work on induction, ${pool.length - ind} don't say so or are non-induction; warranty: ${Object.entries(years).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} (${n})`).join(", ")}. Never say all of them share a feature.`;
    }
    const head = input.storeWide ? `The biggest discounts in the store, one per kind of product; showing ${Math.min(limit, found.length)}.` : input.sort && input.sort !== "relevance" ? `${found.length} matches in the store, sorted by ${input.sort.replace(/_/g, " ")}; showing ${Math.min(limit, found.length)}.` : `${found.length} matches; showing the best ${Math.min(limit, found.length)}.`;
    return [line ? `${head}\n${line}` : head, ...found.slice(0, limit).map((d) => formatDoc(d))].join("\n\n---\n\n");
  }
}

export function runTool(index, name, input = {}) {
  if (name === "search_products") return searchWithFallbacks(index, input);
  if (name === "get_product") {
    const d = index.product(String(input.url ?? "").split("#")[0]);
    return d ? formatDoc(d, { care: true, warranty: true, size: true }) : "No product with that URL. Use a URL from a search result.";
  }
  if (name === "store_policy") {
    const pages = index.search(String(input.topic ?? ""), 40, String(input.topic ?? "")).filter((d) => d.kind !== "product").slice(0, 2);
    return pages.length ? pages.map((d) => formatDoc(d)).join("\n\n---\n\n") : "No store page covers that. Give the customer-care contact.";
  }
  return `Unknown tool ${name}.`;
}
