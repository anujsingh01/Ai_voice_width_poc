// Picks the model for each message: the cheap fast model for simple lookups and
// small talk, the smart model for anything that needs judgement. In a side-by-
// side test Haiku was fine on plain facts but over-generalised on advice ("most
// Svachh cookers work on induction", when 43 don't), so advice, comparisons,
// policies and problems always go to the smart model, and anything unclear does too.

// Questions only the smart model answers.
const ADVICE = new RegExp(
  [
    // choosing and comparing
    "which", "best", "better", "suggest", "recommend", "compare", "comparison", "\\bvs\\.?\\b", "versus", "difference", "should i",
    "kaunsa", "konsa", "kaun sa", "kon sa", "accha", "achha", "behtar", "sahi rahega", "farak", "fark",
    // needs and situations
    "family", "people", "persons?", "members?", "\\blog\\b", "\\blogon", "\\blogo\\b", "for my", "mere liye", "gift", "kitchen",
    "cook(?:ing)?\\b", "biryani", "\\bdal\\b", "\\brice\\b", "chawal", "idli", "dosa", "roti",
    // policies and problems, where a wrong answer costs trust
    "return", "refund", "exchange", "replace", "warrant", "guarant", "cancel", "deliver", "shipping", "\\bcod\\b", "\\bemi\\b",
    "complain", "problem", "issue", "not working", "broken", "damage", "leak", "kharab", "defect", "repair", "service",
    "safe", "induction", "\\bgas\\b", "why", "how (?:to|do|does|can)", "kaise", "kyun", "kyon",
  ].join("|"),
  "i",
);

// Simple messages the fast model handles well.
const SIMPLE = new RegExp(
  [
    // greetings, thanks, goodbyes
    "^(?:hi+|hello|hey|namaste|namaskar|good (?:morning|afternoon|evening)|thanks?|thank you|thx|dhanyavaad|shukriya|ok(?:ay)?|bye|cool|great|nice)\\b",
    // price, stock and link lookups
    "price", "\\bcost", "kitn[ae]", "how much", "\\brate\\b", "\\bmrp\\b", "discount", "offer",
    "in stock", "available", "availability", "milega", "hai kya", "link", "colou?r", "size", "dimension", "weight", "capacity",
  ].join("|"),
  "i",
);

export function pickTier(messages) {
  // Replies to the assistant's own questions ("gas or induction?") don't match
  // SIMPLE, so they stay with the smart model that asked.
  const last = messages.at(-1)?.content ?? "";
  const text = typeof last === "string" ? last : last.map((c) => c.text ?? "").join(" ");
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words > 14 || ADVICE.test(text)) return "smart";
  return SIMPLE.test(text) ? "fast" : "smart";
}
