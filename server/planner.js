// Step 1 of every answer: a fast model reads the chat and decides which store
// searches to run, the way a showroom person would think ("rice and dal for
// one" -> a 2-3 L pressure cooker; "induction cooker that saves electricity" ->
// energy-saving induction cooktops). The searches always run, so the answering
// model starts from real store data instead of guessing from memory, and it can
// still search more with the tools.

import { runTool, categoryList } from "./tools.js";

export const plannerPrompt = (index) => `You plan product searches for the shopping assistant of the TTK Prestige online store (Indian kitchenware: pressure cookers, cookware, gas stoves, induction cooktops, mixer grinders, appliances).

Read the chat, work out what the customer actually needs right now, and reply with JSON only, no other text:
{"done":true,"searches":[{"query":"...","category":"...","material":"...","size_litres":0,"induction":true,"min_price":0,"max_price":0,"sort":"..."}],"policy":""}

Has the customer finished? They talk by voice and the microphone sends their words whenever they pause, so a message can be only the first half of a sentence. Ask: could a person naturally stop talking right after these last words? If yes, "done": true, even when the message is short, vague or missing context ("hi", "yes", "5 litre", "on gas", "how much is it", "kitne ka hai", "I want a cooker for my mother", or an answer to the assistant's question). "done": false only when the last words can't end a sentence: it breaks off mid-phrase ("I want a cooker for my", "mujhe ek", "which is better, the", "the one which has"), ends on a joining word (and, or, but, because, with, aur, lekin, matlab), announces more without saying it ("I have two questions, first", "actually I was thinking"), or is only a filler or call for attention ("wait", "one second", "hmm", "suniye", "ek minute"). Then still plan for what they said so far.

How to plan:
- Use real Indian kitchen knowledge to turn the need into products, with sensible sizes: cookers 1-2 people 2-3 L, 3 people 3-3.5 L, 4 people 5 L, 5-6 people 7.5 L, more 10 L+; a family kadai or fry pan is 24-28 cm; a dosa tawa 28-30 cm; dal and rice for one person -> 2-3 L pressure cooker; family of 4 -> 5 L cooker; "induction cooker" -> induction cooktop (unless they clearly mean a pressure cooker that works on induction); saves electricity -> query "energy saving" with sort watts_low_to_high; frequent power cuts -> gas stove; daily dosa -> dosa tawa; first kitchen -> a pressure cooker sized for the household by the guide above (a couple: 3 L; unknown: 3 L for 1-2 people, 5 L for a family), gas stove, 24 cm kadai, 28 cm tawa (one search each, with those sizes in the query); a gift -> what suits the person, or gift/combo sets.
- Add-on for cross-selling: when they're choosing a main product, add one more search for a natural add-on the salesperson can suggest: pressure cooker -> spare gasket for that size, or a smaller second cooker for a family; gas stove -> non-stick tawa or kadai; induction cooktop -> induction-compatible cookware (fry pan or kadai); mixer grinder -> hand blender or juicer; tawa or kadai -> fry pan. Skip it for complaints, policies and follow-ups that are only about details.
- 1-3 searches, up to 4 when they ask for several kinds of product. When the right choice depends on something they haven't said (glass top or steel, gas or induction), search both options so the assistant can show either. One search per product when they compare named products, with the product name as the query.
- query: short English store words, including the model name if they named one ("Nakshatra Plus pressure cooker", "mixer grinder 750W", "dosa tawa").
- Only include the fields you need. category: a phrase from the category list ("Pressure Cookers", "Induction Cooktops", "Mixer Grinder", "Gas Stove", "Kadai", "Dosa Tawa", "Kettles"...). material: one of stainless steel, aluminium, hard anodised, triply, cast iron, non-stick, ceramic, glass. size_litres: a number. induction: true when they cook on induction. max_price/min_price: their budget in rupees. sort: price_low_to_high when they ask for the cheapest, or the price of a kind of product ("stainless steel cooker 3 litre price?", "kettle price") but not of a named model, (a budget like "under 5000" is max_price, sorted by relevance, so the best product within it comes first), watts_high_to_low for most powerful, watts_low_to_high for least power use, discount_high_to_low for offers, deals, sale, discount, chhoot ("best offers?" with no product named -> query "" with sort discount_high_to_low; "offers on cookers" -> query "pressure cooker" with that sort).
- "Does X work on induction?" or "is X steel?": search X without the induction or material filter, so the answer can tell which models do and which don't.
- Plan for the latest message. Earlier chat only fills in what the latest message leaves open: a follow-up about the same product ("which is cheaper?", "its warranty?", "the 3 litre one") keeps that product and its filters (family size, stove, budget, material). When the latest message asks about another kind of product ("now show me kettles", "induction cooktop ke bare mein batao"), plan only for that product and don't carry over sizes, budgets or filters from the earlier one. This holds even when the words also fit the assistant's last question: after "gas or induction?", "gas stove under 5000" asks for gas stoves (query "gas stove", max_price 5000), not for the cooker on gas; "on gas" alone is the answer. When they ask for a variant of what was suggested ("steel wala hai?", "a bigger one?", "any in black?"), keep their needs (size, stove, family) but drop the suggested model's name from the query, so other models with that material, size or colour can be found ("pressure cooker 5 litre" with material stainless steel, not "Nakshatra Plus 5 litre").
- Always give the salesperson something real to recommend. When the exact thing may not be in the store, also search for the closest thing the store does sell that meets the same need: another brand ("Hawkins Contura") -> the Prestige equivalent (hard anodised pressure cooker, same size); a model in a size that may not exist ("Deluxe Alpha 8 litre") -> that model without the size, plus that kind of product in the nearest size; a product Prestige may not sell or that may be out of stock ("microwave", "water purifier") -> that product, plus what does the job (microwave -> OTG oven and air fryer; water purifier -> electric kettle for boiling water); something unrelated to kitchens (fridge, TV) -> no search.
- Prefer in-stock products with a good discount when choosing between equally good options: add sort only when asked, but for browsing ("show me", "what's good") search the kind of product without filters so the salesperson can pick a well-priced one.
- Warranty of a kind of product ("warranty on pressure cookers?"): search that kind of product, since each product page states its warranty; for the terms of a warranty claim, also set policy.
- Orders, returns, refunds, cancellation, delivery, payment, COD: put the topic in "policy" (e.g. "return damaged product"); add a product search only if they also ask about a product. Repairs and spare parts: search the part ("gasket 5 litre", "whistle").
- "Too expensive", "something cheaper", "budget kam hai": the same kind of product with the same needs (size, stove), max_price just below the price the assistant last suggested, sort price_low_to_high.
- "Just browsing", "what's popular", "show me something": one search for a popular everyday product (e.g. "Svachh pressure cooker 5 litre"), so the salesperson can show one.
- Another brand ("Hawkins is cheaper"): search the Prestige product of that kind ("pressure cooker 5 litre"), so the salesperson can show what Prestige offers.
- Greetings, thanks, off-topic or "are you human": {"done":true,"searches":[],"policy":""}.

Store categories (product count): ${categoryList(index)}`;

// The chat as plain text for the planner: the last few turns are enough.
export function plannerInput(messages) {
  const turns = messages.filter((m) => m.role === "user" || m.role === "assistant").slice(-6);
  const text = turns
    .map((m) => `${m.role === "user" ? "CUSTOMER" : "ASSISTANT"}: ${typeof m.content === "string" ? m.content : m.content.map((c) => c.text ?? "").join(" ")}`)
    .join("\n");
  return `${text}\n\nPlan the searches for the customer's latest message.`;
}

export function parsePlan(text) {
  const json = String(text).match(/\{[\s\S]*\}/);
  if (!json) return null;
  try {
    const plan = JSON.parse(json[0]);
    return { done: plan.done !== false, searches: Array.isArray(plan.searches) ? plan.searches.slice(0, 4) : [], policy: typeof plan.policy === "string" ? plan.policy : "" };
  } catch {
    return null;
  }
}

// Runs the plan. Returns the text block for the answering model and the
// products it contains (for the reply's cards).
export function runPlan(index, plan, latest = "") {
  const parts = [];
  // Cheapest, or the price of a kind of product ("kettle price?"), where the
  // answer should start from the lowest price rather than a random few.
  const wantsCheapest = /cheap|lowest|sasta|sasti|kam (daam|price)|least expensive|expensive|costly|mehe?nga|budget kam|सस्ता|महंगा|\bprice\b|\bkitne ka\b|\bkitna\b|\brate\b|\bdaam\b|कीमत/i.test(latest);
  const wantsOffers = /offer|deal|discount|sale\b|chhoot|chhut|chut\b|chhūt|छूट|ऑफर|डील|सेल|बचत|saving|off\b/i.test(latest);
  const wantsPower = /powerful|strongest|most power|high power|heavy[- ]duty|electricity|energy|bijli|power sav|low power|less power|kam power|kam bijli/i.test(latest);
  for (let s of plan.searches) {
    if (!s || typeof s.query !== "string" || (!s.query.trim() && s.sort !== "discount_high_to_low")) continue;
    s = { ...s };
    // Sort only when the customer asked for it: a budget ("under 6000") wants
    // the best product within it, and "750 watt mixer" wants 750 W, not the most powerful.
    if (s.sort === "price_low_to_high" && !wantsCheapest) delete s.sort;
    if (/^watts/.test(s.sort ?? "") && !wantsPower) delete s.sort;
    if (s.sort === "discount_high_to_low" && !wantsOffers) delete s.sort;
    if (!s.query.trim() && !s.sort) continue;
    // "Cooking Appliances > Gas Stove > Glass Top" would hide the steel stoves;
    // keep the kind of product ("Gas Stove") unless they asked for that type.
    if (typeof s.category === "string") {
      const levels = s.category.split(">").map((x) => x.trim()).filter(Boolean);
      s.category = levels.length > 2 && !latest.toLowerCase().includes(levels.at(-1).toLowerCase()) ? levels[1] : levels.at(-1) ?? "";
    }
    const input = { ...s, limit: s.sort && s.sort !== "relevance" ? 4 : 3 };
    const filters = Object.entries(s).filter(([k, v]) => k !== "query" && v !== "" && v !== 0 && v != null).map(([k, v]) => `${k}=${v}`).join(", ");
    const found = runTool(index, "search_products", input); // relaxes empty searches itself (tools.js)
    parts.push(`SEARCH "${s.query}"${filters ? ` (${filters})` : ""}:\n${found}`);
  }
  if (plan.policy) parts.push(`STORE PAGES on "${plan.policy}":\n${runTool(index, "store_policy", { topic: plan.policy })}`);
  return parts.join("\n\n======\n\n");
}
