// Chat backend for the voice + text widget.
//   GET  /             demo page with the widget
//   GET  /widget.js    the embeddable widget
//   POST /api/chat     { messages: [{role, content}], mode: "text" | "voice" } -> streamed plain text,
//                      then optionally "\u001e" + JSON product cards
//   GET  /api/product?url=...  full details of one product, for the in-chat product view
//   POST /api/tts      { text } -> MP3 from ElevenLabs or Google Cloud TTS (only when one of their keys is set)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import os from "node:os";
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { ProductIndex, formatDoc, tokenize, wantsDetail } from "./search.js";
import { TOOLS, runTool, categoryList } from "./tools.js";
import { plannerPrompt, plannerInput, parsePlan, runPlan } from "./planner.js";
import { pickTier } from "./router.js";
import { Usage } from "./usage.js";
import { saveSettings, mask } from "./settings.js";
import { AnswerCache, questionKey, fingerprint, normalize } from "./cache.js";
import { Verify, whatsappReady } from "./verify.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, "..", "public");
const PORT = Number(process.env.PORT ?? 3030);
// Only this computer can reach the server directly; the website reaches it
// through nginx (deploy/nginx.conf). HOST=0.0.0.0 opens it to the network.
const HOST = process.env.HOST ?? "127.0.0.1";
const MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-5-5";
// The cheaper model plans the store searches (planner.js) and takes over the
// answers only when the Sonnet budget runs out. Every answer is a sales
// conversation, so Sonnet writes all of them; ROUTING=on sends greetings and
// simple price/stock lookups to the cheaper model again.
const FAST_MODEL = process.env.CLAUDE_FAST_MODEL ?? "claude-haiku-5-5";
const ROUTING = process.env.ROUTING === "on";
// Settings below are read on every request so /admin.html can change them live.
// Spending guard: once Sonnet has used SONNET_BUDGET_USD this month, every reply
// goes to the cheap model until the 1st; at MONTHLY_BUDGET_USD in total the
// assistant pauses and points shoppers to customer care. Set the Anthropic
// console limit to MONTHLY_BUDGET_USD as the hard cap.
const sonnetBudget = () => Number(process.env.SONNET_BUDGET_USD ?? 500);
const monthlyBudget = () => Number(process.env.MONTHLY_BUDGET_USD ?? 600);
// Password for /report.html and /admin.html. Without it they only open on this computer.
const reportToken = () => process.env.REPORT_TOKEN;
const ENV_FILE = path.join(here, "..", ".env");
// Semrush average monthly visits (India, desktop + mobile, Jan–Oct 2026), so the
// report can turn the pilot's measured chat share into a monthly forecast.
const MONTHLY_VISITS = Number(process.env.MONTHLY_VISITS ?? 1665170);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "*").split(",").map((s) => s.trim());
const ASSISTANT_NAME = process.env.ASSISTANT_NAME ?? "Prestige Assistant";
// Read on each call, so a voice or model picked in /admin.html applies at once.
const elevenVoice = () => process.env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";
const elevenModel = () => process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5";
// e.g. https://api.in.residency.elevenlabs.io for India data residency
const ELEVENLABS_BASE_URL = process.env.ELEVENLABS_BASE_URL ?? "https://api.elevenlabs.io";
// Google Cloud TTS: the same Google Hindi voice Chrome has, for browsers that
// lack it (Safari, iPhone, Firefox). WaveNet costs about $4 per million characters.
const GOOGLE_TTS_VOICE = process.env.GOOGLE_TTS_VOICE ?? "hi-IN-Wavenet-A";
const tts = () => (process.env.ELEVENLABS_API_KEY ? "elevenlabs" : process.env.GOOGLE_TTS_API_KEY ? "google" : null);

const usage = new Usage(path.join(here, "..", "data", "usage"));
const verify = new Verify(path.join(here, "..", "data", "verify"));
const answers = new AnswerCache(path.join(here, "..", "data", "cache", "answers.json"));
const index = new ProductIndex(path.join(here, "..", "data", "catalog.json"));
// "demo" answers through the Claude app on this computer (free, for showing it);
// "live" through the API key. Without a key it is always demo.
const mode = () => (process.env.MODE !== "demo" && process.env.ANTHROPIC_API_KEY ? "live" : "demo");
let client = null, clientKey = null;
function api() {
  if (process.env.ANTHROPIC_API_KEY !== clientKey) {
    clientKey = process.env.ANTHROPIC_API_KEY;
    client = new Anthropic({ apiKey: clientKey });
  }
  return client;
}
// Local testing without an API key: answers come from the Claude Code CLI
// installed on this machine, signed in with your Claude account. Not for the
// live website, which needs ANTHROPIC_API_KEY.
const CLI = process.env.CLAUDE_CLI ?? "claude";
const CLI_MODEL = process.env.CLAUDE_CLI_MODEL ?? "sonnet";
const CLI_FAST_MODEL = process.env.CLAUDE_CLI_FAST_MODEL ?? "haiku";

const SYSTEM = `You are ${ASSISTANT_NAME}, the in-store salesperson on the TTK Prestige online store (shop.ttkprestige.com). You sell Prestige kitchen products: pressure cookers, cookware, gas stoves, induction cooktops, mixer grinders and other appliances.

This is a conversation, not a Q&A - that matters more than anything else here:
Talk the way the best AI assistant would talk with someone, and the way a warm, knowledgeable person in a Prestige showroom would: you listen, you get curious about their kitchen and their family, you share what you actually know, and you help them land on the right thing. They should feel they're chatting with someone smart and friendly, not filling in a form or reading a brochure.
- Follow their lead. Respond to what they actually said and meant, including small talk, worries, jokes, or a half-finished thought. Remember everything from earlier in the chat and build on it ("since it's just the two of you and you're on induction...").
- Share real knowledge freely, like a good assistant: how to choose between materials, what size really suits a family, how to cook dal without the cooker spitting, why a whistle leaks, how to look after a non-stick pan. General kitchen knowledge is welcome; facts about the store's products (prices, stock, sizes, specs, warranty) come only from the store.
- When they're shopping, help them decide like a trusted friend who knows the products: suggest what really fits and say why in kitchen terms, mention a better-value step up or a cheaper option when it genuinely helps, and when they're ready, tell them they can tap the card and add it to their cart right here. That's how you sell: by being the most helpful person they talked to today. Never pushy, never a script.
- Answer the latest message. Earlier chat is background: use it when they build on it ("its warranty", "the cheaper one"), but when they move to something new, move with them completely and answer exactly what they now asked.
- You're a salesperson, so when they're shopping or asking about products, recommend at least one specific product from the store with its price and link, and say in kitchen terms why it suits them. Small talk, complaints and policy questions don't need one.
- When what they asked for isn't available (another brand, a model or size the store doesn't have, out of stock, something Prestige doesn't sell), say so in a few words, then in the same reply recommend the closest product from the store results that does the same job and why it's a good choice for them ("We don't have microwaves, but for reheating and baking the Prestige ... OTG at ₹... is a great pick"). Never stop at "we don't have it", and never offer to look for it instead of showing it. Only for things unrelated to a kitchen (a fridge, a TV) just say it's not something Prestige makes and mention what you can help with.
- The offer is the discount shown on the product (sale price vs MRP): mention it when you recommend something ("₹3,345, that's 30% off the ₹4,780 MRP"), and when two options are close, point out the better deal. That is the only offer you know about: never invent coupons, bank offers, sales, free gifts or deadlines.
- Don't force a formula beyond that: ask a question when you're actually curious or need it to help them; suggest an add-on only when it would truly be useful. Vary how you start and end.
- Keep turns conversational: usually 2-4 sentences and never more than about 80 words, like a chat message from a person on their phone. Don't dump everything at once; say the most useful thing and let the conversation carry the rest. Only a comparison or a list they asked for may run to about 120 words.
- Every store product you name gets its price and a markdown link from the store results, woven into the sentence ("the [Prestige Svachh 5 L](url) at ₹2,215"), in every language, Hindi and Hinglish included; never a bare URL or a bold name without its link, and never type a link from memory.
- When a search shows a NOTE (nothing under their budget, not in that size, out of stock), say that plainly in a few words and recommend the best of what it shows instead: "Nothing under ₹800, I'm afraid; the most affordable is the [Nakshatra Plus 2 L](url) at ₹1,280, 15% off." Prices are exact (never "around ₹100-150"), and never call part of a pack "free".
- Match their language and register: English, Hindi, Hinglish, Tamil, etc. If they're upset, be human about it first and help fix it before anything else. If they compare with another brand, be fair and talk about what Prestige really offers (the product's own warranty and features, the service number for repairs).
- Never open with "Great question!", "Certainly!" or "I'd be happy to help", and never end with "Let me know if you have any other questions."

What you know, and how to find more:
- You know nothing about the store's current products, prices or stock except what the store gives you. Each customer message comes with STORE SEARCH RESULTS: searches already run for this question (their filters are shown). Base your answer on them.
- If they don't cover what the customer actually needs, search more with your store tools before answering: search_products (category, material, size, induction, price range, price or wattage sorting), get_product (one product's full page) and store_policy (returns, delivery, payment, FAQ pages). Several searches are fine; a wrong answer is not. Never mention a product, price or link you didn't get from the store.
- When you recommend a kind of product (a gas stove, a hard anodised kadai), name a specific one from the store with its price and link.
- Don't write anything to the customer until your searches are done, and never mention searching, tools or "the information I have"; just answer like someone who knows the store. Never offer to look something up or get back to them ("want me to check...?", "shall I check...?", "want me to check back once stock updates?", "want me to pull up...?", "tell me X and I'll point you to...", "let me know and I'll find...", "I can check if..."): you can't check later, and the customer wants the answer now. If you're about to write that, call search_products instead and show what you found; if you need something from them, just ask it ("How many burners do you need?"). Never refer to "the list", "the results" or what you're "seeing".
- Use your own kitchen knowledge to work out what they really need, then find that in the store: dal and rice for one person means a 2-3 L pressure cooker, everyday dosa means a dosa tawa, frequent power cuts mean gas rather than induction, "induction cooker" usually means an induction cooktop.
- If you need to know something to help (gas or induction, how many people), it's fine to suggest something sensible first and ask in the same breath, the way a person would.
- Your product facts (prices, sizes, materials, warranty, stock, features) come only from the product information and your search results.
- Never invent a product, price, spec, offer or policy. If the information isn't there, say you're not sure and suggest checking the product page or contacting Prestige: for website orders, returns and delivery call +91 95356 21112 (Mon-Sat, 9:30 am-6 pm) or email customercare@ttkprestige.com; for product service, repairs and spare parts call 080-46824000.
- Returns, refunds, cancellations, delivery times and warranty: say only what the INFO PAGE or WARRANTY text says, in your own words. Never add a reason, condition, time limit or exception that isn't written there. When a policy has more than one time limit (for example, reporting damage vs sending the item back), give each one with what it applies to. If it isn't covered, give the customer-care contact above.
- "Does it work on induction / gas?": answer yes or no from that product's specs or key features (the Base, Induction Compatible, Gas and Induction lines) and name the product. If the information doesn't say, say so; never call a product gas-only or non-induction unless its information says that.
- Comparing products: put the real differences side by side (material, stove type, sizes, warranty, price, stock), each fact from that product's own information, then say which you'd pick for whom.
- When they ask for a material or feature (steel, induction, glass top, auto ignition), recommend only products whose information shows it. Read the Material and Base lines; aluminium is not steel. If none of the products shown has it, say so.
- Read sizes, prices and compatibility lists exactly as written: a price belongs to the size or pack it's listed with (a 5 L + 3 L combo price is not a 3 L price), and a part fits only the models and sizes its page lists: for spare parts, name only the models whose line includes the customer's size (a gasket for "Popular 5.5 L and 6.5 L" doesn't fit a 5 L Popular).
- When they name a product ("is the Svachh Hard Anodised 5 L in stock?"), answer about the closest match first: in stock or not, the price, the link. Then mention a close alternative if there is one.
- Warranty differs from model to model (1, 2, 5 or 10 years). Give the warranty of the specific product; if you don't know which product they have, ask or point to the invoice and the service number.
- Cooker size guide, so every answer agrees: 1–2 people 2–3 L; 3 people 3–3.5 L; 4 people 5 L (a 3 L is handy as a second cooker); 5–6 people 5.5–7.5 L; 7 or more 7.5 L and up.
- Speak only about products in the information or your search results. Never claim something about a whole range or brand ("all Svachh cookers", "all Prestige non-stick pans are PFOA-free", "most of our models"): the store has many variants that differ, so say it about the specific product whose information shows it.
- Searches show a few products, not the whole store. Call something the cheapest only after a cheapest-first search with the right filters (or when the information says these are the cheapest). Never count what the store has ("we've got four") or present a list as all of them ("here are the 3 L cookers we have"), and never give a store-wide price range ("kettles range from ₹780 to ₹2,020"); say "starting at ₹780" instead.
- If a product is out of stock or has no price listed, say so and recommend a similar in-stock option (search for one if none is shown).
- Prices on the site can change; when you quote one, it's the price shown on the website.
- If someone asks whether you are a person, say honestly that you are an AI assistant for the Prestige store.
- Politely steer off-topic requests back to Prestige products and orders. For order tracking, returns or service complaints, point them to customer care.

The store's product categories (product count): ${categoryList(index)}`;

const VOICE_NOTE =
  "The customer is talking with you by voice, like a phone call, and your reply is read aloud. Talk the way people actually talk on a call: short turns of 1-2 sentences, natural and warm, then let them speak - don't read out a paragraph. If there's more to say, say the most useful part and offer the rest ('want the details?'). No markdown, lists, links, URLs, emojis or symbols. Write sizes and prices as digits, like '5 litre' and '2,030 rupees': the voice reads digits correctly in English and Hindi, while spelled-out Hinglish numbers come out garbled. You can mention they'll see the product in the chat.";

// Repeated next to every question, where the model reads it last: the few
// selling rules that drift in long chats.
const REMINDER = "(Reply rules: answer this latest message. If they're shopping, recommend a specific in-stock product from the results above, written as a markdown link [name](url) with its price and discount, and why it suits them; every product you name gets its link, never a bare URL. If what they asked for isn't there, say so briefly and recommend the closest one. Say a product works on induction only if its Base says so. Cooker sizes follow the size guide for their household (two people: 2-3 L, not 5 L). End with one short next step: a question, or tap the card to add it to your cart. Never offer to check or look something up later.)";
const REMINDER_VOICE = "(Reply rules: answer this latest message. If they're shopping, name one specific in-stock product from the results above with its price and discount, and why it suits them; if what they asked for isn't there, say so briefly and recommend the closest one. Say a product works on induction only if its Base says so. Cooker sizes follow the size guide for their household (two people: 2-3 L, not 5 L). It's a phone call: at most 3 short sentences, about 40 words, one product; if you need to ask something, ask it at the end. End with one short next step: a question, or tap the card to add it to your cart. Never offer to check or look something up later.)";

const hits = new Map();
function rateLimited(ip, bucket = "chat", perMinute = 20) {
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > perMinute;
}
// Addresses that have gone quiet are forgotten, so the list doesn't grow for ever.
setInterval(() => {
  const now = Date.now();
  for (const [key, times] of hits) if (now - times.at(-1) > 60_000) hits.delete(key);
  for (const [ip, times] of badLogins) if (now - times.at(-1) > LOCKOUT_MS) badLogins.delete(ip);
}, 60_000).unref();

// Behind nginx every request comes from 127.0.0.1, so a forwarded one is never local.
const isLocal = (req) => !req.headers["x-forwarded-for"] && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
const clientIp = (req) => req.headers["x-forwarded-for"]?.split(",")[0] ?? req.socket.remoteAddress;

function cors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes("*")) res.setHeader("Access-Control-Allow-Origin", "*");
  else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  // Lets the live store page reach a server on this machine while testing
  // locally. Never sent on the live site, where requests come through nginx.
  if (isLocal(req) && req.headers["access-control-request-private-network"]) res.setHeader("Access-Control-Allow-Private-Network", "true");
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 100_000) throw new Error("Body too large");
  }
  return JSON.parse(body);
}

// Keep the last turns, plain strings only, starting with a user turn.
function sanitizeHistory(raw) {
  const msgs = (Array.isArray(raw) ? raw : [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }))
    .slice(-12);
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  return msgs;
}

async function handleChat(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain" });
    return res.end("Bad request");
  }
  // Answers the widget prepares during a pause (turnCheck) are often thrown
  // away when the customer carries on, so they get a bucket of their own.
  if (rateLimited(clientIp(req), body.turnCheck ? "turn" : "chat", body.turnCheck ? 60 : 20)) {
    res.writeHead(429, { "Content-Type": "text/plain" });
    return res.end("You're sending messages a little fast. Please wait a moment and try again.");
  }
  const messages = sanitizeHistory(body.messages);
  const last = messages.at(-1);
  if (!last || last.role !== "user") {
    res.writeHead(400, { "Content-Type": "text/plain" });
    return res.end("Last message must be from the user");
  }

  const spend = usage.monthSpend;
  if (spend >= monthlyBudget()) {
    console.warn(`Monthly budget of $${monthlyBudget()} reached ($${spend.toFixed(2)}); assistant paused.`);
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Sorry, I'm not available right now. For help with orders, returns or delivery, please call +91 95356 21112 (Mon-Sat, 9:30 am-6 pm) or email customercare@ttkprestige.com.");
  }
  const visitor = body.visitor;
  // After the free questions, a WhatsApp number check (verify.js). "\u0007"
  // tells the widget to show the number form; nothing is spent on this reply.
  const who = { visitor: String(visitor ?? ""), ip: clientIp(req) };
  // The nightly warm-up and the quality test, run on this computer, skip it.
  const internal = isLocal(req) && /^(warmupnightly|qualitytest\d+)$/.test(who.visitor);
  const gate = internal ? { status: "ok", internal } : verify.check({ ...who, token: body.verified });
  if (gate.status !== "ok") {
    const voiceTurn = body.mode === "voice";
    if (gate.status === "verify") usage.verify("gate", visitor);
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" });
    return res.end((body.turnCheck ? "\u0006" : "") + (gate.status === "verify"
      ? "\u0007" + (voiceTurn ? "To keep chatting, please confirm your WhatsApp number in the chat. I'll send you a code on WhatsApp." : "To keep chatting, please confirm your WhatsApp number below. We'll send you a 6-digit code on WhatsApp; it takes a few seconds.")
      : "That's all the questions I can answer today. For more help, please call +91 95356 21112 (Mon-Sat, 9:30 am-6 pm) or email customercare@ttkprestige.com."));
  }
  const tier = usage.monthSmartSpend >= sonnetBudget() ? "fast" : !ROUTING ? "smart" : pickTier(messages);
  const started = Date.now();
  let firstMs = 0;
  const mark = () => firstMs || (firstMs = Date.now() - started);

  // Step 1: plan the searches (planner.js) and run them, so the answer always
  // starts from real store data. If planning fails, fall back to a keyword search.
  let found = "";
  const gone = new AbortController(); // the widget dropped the request (the customer kept talking)
  res.on("close", () => res.writableEnded || gone.abort());
  const plan = parsePlan(await makePlan(messages, visitor, gone.signal).catch((err) => (gone.signal.aborted || console.error("Planner failed:", err.message), "")));
  if (gone.signal.aborted) return;
  // Voice turns sent at a pause: first say whether the customer has finished.
  // If they haven't, stop here and let the widget keep listening.
  if (body.turnCheck) {
    const done = plan?.done !== false;
    if (process.env.DEBUG) console.log(`turn ${done ? "done" : "not finished"}: ${JSON.stringify(last.content)}`);
    if (!done) return res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("\u0015");
  }
  if (!gate.internal) verify.count({ ...who, phone: gate.phone });
  if (plan) {
    found = runPlan(index, plan, last.content);
    if (process.env.DEBUG) console.log(`plan: ${JSON.stringify(plan)}`);
  }
  else {
    // The latest question weighted most, plus recent user turns so follow-ups
    // like "what about the 5 litre one?" still find the product.
    const userTurns = messages.filter((m) => m.role === "user").map((m) => m.content);
    const query = [last.content, last.content, ...userTurns.slice(-3, -1)].join(" ");
    const guess = index.compare(last.content, 4) ?? index.search(query, 4, last.content);
    found = guess.map((d) => formatDoc(d, wantsDetail(last.content))).join("\n\n---\n\n");
  }
  const docs = productsIn(found);

  // A first question asked before, with the same search results as then: send
  // the answer written then. Any change in a price, discount, stock or the
  // products found gives a new fingerprint, and a fresh answer (cache.js).
  const voice = body.mode === "voice";
  const qKey = tier === "smart" && messages.filter((m) => m.role === "user").length === 1 ? questionKey(last.content) : null;
  const answerKey = qKey && `${voice ? "voice" : "text"}|${qKey}`;
  const inputs = answerKey && fingerprint(SYSTEM, REMINDER, REMINDER_VOICE, VOICE_NOTE, found);
  const stored = answerKey && answers.get(answerKey, inputs);
  if (stored) {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" });
    usage.ready({ visitor, mode: voice ? "voice" : "text", firstMs: Date.now() - started });
    if (process.env.DEBUG) console.log(`ready answer: ${JSON.stringify(qKey)}`);
    return res.end((body.turnCheck ? "\u0006" : "") + stored);
  }
  if (answerKey) {
    // Keep what was sent, and store it if the answer finished normally from
    // these search results alone (an extra search during the answer isn't
    // in the fingerprint, so those answers aren't stored).
    let out = "";
    const write = res.write.bind(res), end = res.end.bind(res);
    res.write = (chunk, ...rest) => ((out += chunk ?? ""), write(chunk, ...rest));
    res.end = (chunk, ...rest) => {
      if (typeof chunk === "string") out += chunk;
      const text = out.replace(/^\u0006/, "");
      const failed = /Sorry, I'm having trouble|Sorry, I can't help/.test(text) || text.includes("\u001f");
      if (!res.usedTools && !failed && !gone.signal.aborted && text.trim().length > 20) answers.set(answerKey, inputs, text);
      return end(chunk, ...rest);
    };
  }
  messages[messages.length - 1] = {
    role: "user",
    content: [
      { type: "text", text: `<store_search_results>\n${found || "(No searches were needed for this message.)"}\n</store_search_results>` },
      { type: "text", text: body.mode === "voice" ? REMINDER_VOICE : REMINDER },
      { type: "text", text: last.content },
    ],
  };

  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
  });
  if (body.turnCheck) res.write("\u0006");

  const log = (model, u) => usage.message({ visitor, tier, model, mode: body.mode === "voice" ? "voice" : "text", usage: u, firstMs, totalMs: Date.now() - started });
  if (mode() === "demo") {
    const cliModel = tier === "fast" ? CLI_FAST_MODEL : CLI_MODEL;
    return answerWithCli(res, messages, body.mode === "voice", docs, cliModel, mark, (u) => log(cliModel, u), gone.signal);
  }

  try {
    // Claude may search the store a few times before it answers; only its
    // text reaches the customer, streamed as it's written.
    const seen = [...docs];
    const used = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    let reply = "", final, model;
    const links = linkFixer(seen);
    // The customer kept talking or closed the chat: stop paying for this answer.
    let stream;
    gone.signal.addEventListener("abort", () => stream?.abort());
    for (let round = 0; round < 5; round++) {
      if (gone.signal.aborted) return;
      stream = api().beta.messages.stream({
        max_tokens: 4096,
        // Medium effort: in testing, low effort answered from the first results
        // instead of searching properly ("all mixers are 750W" when 1000W exist).
        output_config: { effort: "medium" },
        // Both models think before answering unless told not to, which delays the
        // first word by seconds. Sonnet 5.5 turns it off with "between_tools"
        // (it may still think after a search), Haiku 5.5 with "disabled".
        // Haiku has no server-side fallback and rejects the option.
        ...(tier === "fast"
          ? { model: FAST_MODEL, thinking: { type: "disabled" } }
          : { model: MODEL, thinking: { type: "between_tools" }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }),
        // The voice note comes after the saved part, so voice and text chats
        // share one saved copy of the main instructions.
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }, ...(voice ? [{ type: "text", text: VOICE_NOTE }] : [])],
        tools: TOOLS,
        // The last round must answer.
        ...(round === 4 ? { tool_choice: { type: "none" } } : {}),
        messages,
      });
      stream.on("text", (delta) => {
        const out = links.feed(delta);
        if (!out) return;
        mark();
        reply += out;
        res.write(out);
      });
      final = await stream.finalMessage();
      model = final.model;
      for (const k of Object.keys(used)) used[k] += final.usage?.[k] ?? 0;
      if (final.stop_reason !== "tool_use") break;
      res.usedTools = true;
      // Anything written before a search ("let me check...") was a guess; the
      // widget clears it on \u001f and shows the answer written after the search.
      links.end();
      links.reset();
      if (reply) { res.write("\u001f"); reply = ""; }
      messages.push({ role: "assistant", content: final.content });
      messages.push({
        role: "user",
        content: final.content.filter((b) => b.type === "tool_use").map((b) => {
          const out = runTool(index, b.name, b.input);
          seen.push(...productsIn(out));
          return { type: "tool_result", tool_use_id: b.id, content: out };
        }),
      });
    }
    const tail = links.end();
    reply += tail;
    res.write(tail);
    log(model, used);
    if (final.stop_reason === "refusal") {
      res.write("Sorry, I can't help with that one. Is there a Prestige product I can help you find?");
      return res.end();
    }
    res.end(cardTrailer(reply, seen));
  } catch (err) {
    if (err instanceof Anthropic.APIUserAbortError) return;
    console.error("Claude API error:", err instanceof Anthropic.APIError ? `${err.status} ${err.message}` : err);
    res.end("\n\nSorry, I'm having trouble answering right now. Please try again in a moment.");
  }
}

// Products named in a tool result, so the reply's cards can show them too.
const productsIn = (text) => [...new Set(String(text).match(/https:\/\/shop\.ttkprestige\.com\/[^\s)"\\]+/g) ?? [])].map((u) => index.product(u)).filter(Boolean);

// Checks every markdown link while the reply streams. A link Claude wrote from
// memory that isn't a real store page is pointed at the product its text names
// (preferring products from this conversation's searches), or dropped.
// Only the URL part is held back, so the text still streams word by word.
const isStorePage = (url) => !!index.product(url) || index.docs.some((d) => d.url === url);
function linkFixer(seen) {
  // pending: text not yet sent; held: "[link text" waiting for its URL to be checked.
  let pending = "", held = "", inUrl = false;
  function fix(url, text) {
    const clean = url.split("#")[0];
    if (isStorePage(clean)) return url;
    const want = tokenize(text).filter((t) => !BRAND.has(t));
    const score = (d) => want.filter((t) => tokenize(d.title).includes(t)).length;
    const pool = [...seen, ...index.search(text, 3, text).filter((d) => d.kind === "product")];
    const best = pool.sort((a, b) => score(b) - score(a))[0];
    return best && want.length && score(best) >= Math.min(2, want.length) ? best.url : null;
  }
  // A bare store URL ("... the 28 cm one: https://shop...") becomes a link
  // with the product's name, which the widget shows as a tappable name.
  const bare = (text) => text.replace(/https:\/\/shop\.ttkprestige\.com\/[^\s)\]]*[^\s)\].,!?]/g, (url) => {
    const d = index.product(url.split("#")[0]);
    if (d) seen.push(d);
    return d ? `[${d.title.split(/\s+[|(]|,\s/)[0].trim()}](${url})` : url;
  });
  function feed(chunk) {
    let out = "";
    pending += chunk;
    for (;;) {
      if (!inUrl) {
        const at = pending.indexOf("](");
        if (at < 0) {
          // Hold an open "[link text" (up to 200 characters) until we know whether a link follows.
          const open = pending.lastIndexOf("[");
          let keep = open >= 0 && pending.length - open < 200 ? pending.length - open : 0;
          // A URL still arriving: wait for its end before turning it into a link.
          const url = pending.lastIndexOf("http");
          if (url >= 0 && !/\s/.test(pending.slice(url)) && pending.length - url < 400) keep = Math.max(keep, pending.length - url);
          out += bare(pending.slice(0, pending.length - keep));
          pending = pending.slice(pending.length - keep);
          break;
        }
        const open = pending.lastIndexOf("[", at);
        out += bare(pending.slice(0, open >= 0 ? open : at));
        held = open >= 0 ? pending.slice(open, at) : "";
        pending = pending.slice(at + 2);
        inUrl = true;
      } else {
        const close = pending.indexOf(")");
        if (close < 0 && pending.length < 400) break;
        const url = (close < 0 ? pending : pending.slice(0, close)).trim();
        pending = close < 0 ? "" : pending.slice(close + 1);
        inUrl = false;
        const good = fix(url, held.slice(1));
        if (good !== url) console.warn(`Link ${good ? "repaired" : "dropped"}: ${url}${good ? ` -> ${good}` : ""}`);
        // No real page: keep the words, drop the link.
        out += good ? `${held}](${good})` : held.slice(1);
        held = "";
      }
    }
    return out;
  }
  const end = () => {
    const rest = inUrl ? `${held}](${pending}` : bare(pending);
    pending = held = "";
    inUrl = false;
    return rest;
  };
  const reset = () => { pending = held = ""; inUrl = false; };
  return { feed, end, reset };
}

// Product cards (photo, price, link) for the products the reply actually
// recommends. Matched by link, or by name for voice replies, which have no
// links. Sent after the text, behind a \u001e separator the widget splits on.
const BRAND = new Set(["prestige", "judge", "by", "the", "ttk"]);
const nameKey = (title) => tokenize(title).filter((t) => !BRAND.has(t)).slice(0, 2).join(" ");
function cardTrailer(reply, docs) {
  const text = ` ${tokenize(reply).join(" ")} `;
  const found = [];
  const seen = new Set();
  for (const d of docs) {
    if (d.kind !== "product") continue;
    const key = nameKey(d.title);
    const at = reply.includes(d.url) ? reply.indexOf(d.url) : key.includes(" ") ? text.indexOf(` ${key} `) : -1;
    if (at < 0 || seen.has(d.url)) continue;
    seen.add(d.url);
    found.push({ at, linked: reply.includes(d.url), key, d });
  }
  // Two pages with the same short name: keep the one that was linked or ranked first.
  const byKey = new Map();
  for (const f of found) if (!byKey.has(f.key) || (f.linked && !byKey.get(f.key).linked)) byKey.set(f.key, f);
  const cards = [...byKey.values()]
    .sort((a, b) => a.at - b.at)
    .slice(0, 3)
    .map(({ d }) => ({
      title: d.title,
      url: d.url,
      image: d.image,
      price: d.price,
      mrp: d.mrp,
      off: d.discountPct,
      from: d.variants.length > 1 && new Set(d.variants.map((v) => v.price)).size > 1,
      inStock: d.inStock,
    }));
  return cards.length ? `\u001e${JSON.stringify(cards)}` : "";
}

// Same conversation, answered by the local Claude Code CLI (no API key needed).
// The chat so far goes in as one prompt; text is streamed back as it arrives.
// Starting the CLI takes most of a second, so one copy per model and voice
// setting is started ahead of time and waits for its question.
const spares = new Map();
const PLANNER = plannerPrompt(index);

// The planning step (planner.js): Haiku, no thinking, low effort, so it adds
// about a second. Live mode uses the API; Demo mode a waiting Claude app.
// The same chat always gets the same plan, so a repeated question skips the
// planning step. Plans name searches, not prices, so they don't go stale; the
// searches themselves always run on the current catalogue.
const plans = new Map();
async function makePlan(messages, visitor, signal) {
  const key = fingerprint(PLANNER, normalize(plannerInput(messages)));
  if (plans.has(key)) return plans.get(key);
  const text = await askPlanner(messages, visitor, signal);
  if (parsePlan(text) && !signal?.aborted) {
    if (plans.size >= 2000) plans.delete(plans.keys().next().value);
    plans.set(key, text);
  }
  return text;
}
async function askPlanner(messages, visitor, signal) {
  const input = plannerInput(messages);
  if (mode() === "live") {
    const r = await api().messages.create({
      model: FAST_MODEL, max_tokens: 500, thinking: { type: "disabled" }, output_config: { effort: "low" },
      system: [{ type: "text", text: PLANNER, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: input }],
    }, { signal });
    usage.message({ visitor, tier: "plan", model: r.model, mode: "text", usage: r.usage, firstMs: 0, totalMs: 0 });
    return r.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  }
  const child = takePlanner();
  signal?.addEventListener("abort", () => child.kill());
  child.stdin.end(JSON.stringify({ type: "user", message: { role: "user", content: input } }) + "\n");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => (child.kill(), reject(new Error("planner timed out"))), 15000);
    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const ev = JSON.parse(line);
          if (ev.type === "result") {
            clearTimeout(timer);
            resolve(ev.result ?? "");
          }
        } catch {}
      }
    });
    child.on("close", () => (clearTimeout(timer), resolve("")));
  });
}
function startPlannerCli() {
  return spawn(
    CLI,
    [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--model", CLI_FAST_MODEL, "--effort", "low", "--settings", JSON.stringify({ alwaysThinkingEnabled: false }),
      "--system-prompt", PLANNER,
      "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence",
    ],
    { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] },
  );
}
function takePlanner() {
  const ready = spares.get("planner");
  const child = ready && ready.exitCode === null && !ready.killed ? ready : startPlannerCli();
  const spare = startPlannerCli();
  spare.on("error", () => spares.get("planner") === spare && spares.delete("planner"));
  spares.set("planner", spare);
  return child;
}
function startCli(model, voice) {
  return spawn(
    CLI,
    [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--verbose",
      "--model", model, "--effort", process.env.CLI_EFFORT ?? "medium", // same as the API settings: medium effort, no thinking
      "--settings", JSON.stringify({ alwaysThinkingEnabled: process.env.CLI_THINKING === "on" }),
      "--system-prompt", voice ? `${SYSTEM}\n\n${VOICE_NOTE}` : SYSTEM,
      "--tools", "", "--setting-sources", "", "--no-session-persistence",
      // The same store tools as the API, through server/mcp.js.
      "--mcp-config", JSON.stringify({ mcpServers: { store: { command: process.execPath, args: [path.join(here, "mcp.js")] } } }),
      "--strict-mcp-config", "--allowedTools", TOOLS.map((t) => `mcp__store__${t.name}`).join(","),
    ],
    { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] },
  );
}
function takeCli(model, voice) {
  const key = `${model}:${voice}`;
  const ready = spares.get(key);
  const child = ready && ready.exitCode === null && !ready.killed ? ready : startCli(model, voice);
  const spare = startCli(model, voice);
  spare.on("error", () => spares.get(key) === spare && spares.delete(key));
  spares.set(key, spare);
  return child;
}
function warmCli() {
  if (mode() !== "demo") return;
  if (!spares.has("planner")) {
    const p = startPlannerCli();
    p.on("error", () => {});
    spares.set("planner", p);
  }
  for (const model of [CLI_MODEL, CLI_FAST_MODEL]) for (const voice of [false, true]) if (!spares.has(`${model}:${voice}`)) {
    const c = startCli(model, voice);
    c.on("error", () => {});
    spares.set(`${model}:${voice}`, c);
  }
}
process.on("exit", () => { for (const c of spares.values()) c.kill(); });

function answerWithCli(res, messages, voice, docs, model, mark, log, gone) {
  const transcript = messages
    .map((m) => {
      const text = typeof m.content === "string" ? m.content : m.content.map((c) => c.text).join("\n\n");
      return m.role === "user" ? `CUSTOMER:\n${text}` : m.role === "assistant" ? `YOU:\n${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
  const prompt = `${transcript}\n\nWrite only your next reply to the customer, nothing else.`;

  const child = takeCli(model, voice);
  // The customer kept talking or closed the chat: stop writing this answer.
  gone.addEventListener("abort", () => child.kill());
  child.stdin.end(JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n");

  let buf = "", reply = "", errText = "", used = null;
  const seen = [...docs];
  const links = linkFixer(seen);
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const ev = JSON.parse(line);
        const delta = ev.type === "stream_event" && ev.event?.type === "content_block_delta" && ev.event.delta;
        if (ev.type === "result") {
          if (ev.usage) used = ev.usage;
          finish();
        }
        if (ev.type === "assistant") for (const b of ev.message?.content ?? []) if (b.type === "tool_use") {
          res.usedTools = true;
          if (process.env.DEBUG) console.log(`  tool ${b.name.replace("mcp__store__", "")} ${JSON.stringify(b.input)}`);
        }
        // Products the store tools returned, for the reply's cards.
        if (ev.type === "user" && Array.isArray(ev.message?.content)) {
          for (const b of ev.message.content) if (b.type === "tool_result") seen.push(...productsIn(JSON.stringify(b.content)));
        }
        // Text written before a search is cleared, as in the API loop.
        if (ev.type === "stream_event" && ev.event?.type === "message_delta" && ev.event.delta?.stop_reason === "tool_use" && reply) {
          links.end();
          links.reset();
          res.write("\u001f");
          reply = "";
        }
        if (delta?.type === "text_delta") {
          const out = links.feed(delta.text);
          if (out) {
            mark();
            res.write(out);
            reply += out;
          }
        }
      } catch {}
    }
  });
  child.stderr.on("data", (c) => (errText += c));
  child.on("error", (err) => {
    console.error(`Could not start the Claude CLI (${CLI}): ${err.message}`);
    res.end("Sorry, I'm having trouble answering right now. Please try again in a moment.");
  });
  // The reply is complete at the "result" event; the CLI takes another half
  // second to exit, which the customer shouldn't wait for.
  let exitCode = null;
  function finish() {
    if (res.writableEnded || gone.aborted) return;
    if (!reply) {
      console.error(`Claude CLI gave no reply (exit ${exitCode}): ${errText.slice(0, 500)}`);
      return res.end("Sorry, I'm having trouble answering right now. Please try again in a moment.");
    }
    const tail = links.end();
    reply += tail;
    res.write(tail);
    log(used);
    res.end(cardTrailer(reply, seen));
  }
  child.on("close", (code) => {
    exitCode = code;
    finish();
  });
}

// Proxies one sentence to the voice service so its key never reaches the browser.
async function handleTts(req, res) {
  if (!tts()) return res.writeHead(404).end();
  // A reply is spoken sentence by sentence, so allow more calls than /api/chat.
  if (rateLimited(clientIp(req), "tts", 90)) return res.writeHead(429).end();
  let text;
  try {
    text = String((await readJson(req)).text ?? "").trim().slice(0, 800);
  } catch {
    return res.writeHead(400).end();
  }
  if (!text) return res.writeHead(400).end();
  return tts() === "google" ? googleTts(text, res) : elevenLabsTts(text, req, res);
}

// Greetings and stock phrases repeat a lot; keep their audio so each is paid for once.
const ttsCache = new Map();
const TTS_CACHE_SIZE = 500;

async function googleTts(text, res) {
  let audio = ttsCache.get(text);
  if (!audio) {
    const upstream = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(process.env.GOOGLE_TTS_API_KEY)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: GOOGLE_TTS_VOICE.split("-").slice(0, 2).join("-"), name: GOOGLE_TTS_VOICE },
        audioConfig: { audioEncoding: "MP3", speakingRate: 1.02 },
      }),
    }).catch((err) => ({ ok: false, status: 502, text: async () => err.message }));
    if (!upstream.ok) {
      console.error("Google TTS error:", upstream.status, await upstream.text());
      return res.writeHead(502).end();
    }
    audio = Buffer.from((await upstream.json()).audioContent ?? "", "base64");
    if (!audio.length) return res.writeHead(502).end();
    if (ttsCache.size >= TTS_CACHE_SIZE) ttsCache.delete(ttsCache.keys().next().value);
    ttsCache.set(text, audio);
  }
  res.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" });
  res.end(audio);
}

// ElevenLabs audio is kept too, per voice and model, in memory and, for
// sentences asked for twice, on disk (data/cache/tts), so a restart keeps them.
const TTS_DIR = path.join(here, "..", "data", "cache", "tts");
const ttsSeen = new Map();
function cachedAudio(key) {
  if (ttsCache.has(key)) return ttsCache.get(key);
  const file = path.join(TTS_DIR, `${fingerprint(key)}.mp3`);
  try { return fs.readFileSync(file); } catch { return null; }
}
function keepAudio(key, audio) {
  if (ttsCache.size >= TTS_CACHE_SIZE) ttsCache.delete(ttsCache.keys().next().value);
  ttsCache.set(key, audio);
  const seen = (ttsSeen.get(key) ?? 0) + 1;
  if (ttsSeen.size > 20000) ttsSeen.clear();
  ttsSeen.set(key, seen);
  if (seen === 2) fs.mkdir(TTS_DIR, { recursive: true }, () => fs.writeFile(path.join(TTS_DIR, `${fingerprint(key)}.mp3`), audio, () => {}));
}

async function elevenLabsTts(text, req, res) {
  const key = `eleven|${elevenVoice()}|${elevenModel()}|${text}`;
  const kept = cachedAudio(key);
  if (kept) {
    keepAudio(key, kept);
    res.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" });
    return res.end(kept);
  }
  const upstream = await fetch(
    `${ELEVENLABS_BASE_URL}/v1/text-to-speech/${elevenVoice()}/stream?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text,
        model_id: elevenModel(),
        voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true },
      }),
    },
  ).catch((err) => ({ ok: false, status: 502, text: async () => err.message }));

  if (!upstream.ok || !upstream.body) {
    console.error("ElevenLabs error:", upstream.status, await upstream.text());
    return res.writeHead(502).end();
  }
  res.writeHead(200, { "Content-Type": upstream.headers.get("content-type") ?? "audio/mpeg", "Cache-Control": "no-store" });
  // The sentence is already paid for, so it is kept even if the customer
  // stops listening halfway.
  const audio = Readable.fromWeb(upstream.body);
  const chunks = [];
  audio.on("data", (c) => chunks.push(c));
  audio.on("end", () => keepAudio(key, Buffer.concat(chunks)));
  audio.on("error", () => res.destroy());
  audio.pipe(res);
}

// The widget reports "view" (once a visitor a day) and "open", for the pilot report.
async function handleEvent(req, res) {
  if (rateLimited(clientIp(req), "event", 30)) return res.writeHead(429).end();
  try {
    const { type, visitor } = await readJson(req);
    res.writeHead(usage.event(type, visitor) ? 204 : 400).end();
  } catch {
    res.writeHead(400).end();
  }
}

// The WhatsApp number check: { phone } sends a code, { phone, code } returns a token.
async function handleVerify(req, res, step) {
  const json = (body) => res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
  if (rateLimited(clientIp(req), "verify", 10)) return json({ error: "Please wait a moment and try again." });
  let b;
  try { b = await readJson(req); } catch { return json({ error: "Please try again." }); }
  if (step === "send") {
    const r = await verify.send(b.phone, clientIp(req));
    if (r.ok) usage.verify("otp", b.visitor);
    return json(r);
  }
  const r = verify.confirm(b.phone, b.code);
  if (r.token) usage.verify("verified", b.visitor);
  json(r);
}

// /report.html and /admin.html: the REPORT_TOKEN password, or this computer when none is set.
// Ten wrong passwords from one address lock it out for 15 minutes, so the
// password can't be guessed by trying thousands.
const LOCKOUT_MS = 15 * 60e3;
const badLogins = new Map();
const sha256 = (s) => crypto.createHash("sha256").update(s).digest();
function allowed(req, res) {
  const deny = (code, error) => (res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify({ error })), false);
  if (!reportToken()) return isLocal(req) || deny(401, "Set a password (REPORT_TOKEN) to open this from another computer");
  const ip = clientIp(req), now = Date.now();
  const fails = (badLogins.get(ip) ?? []).filter((t) => now - t < LOCKOUT_MS);
  if (fails.length >= 10) return deny(429, "Too many wrong passwords. Please wait 15 minutes and try again.");
  const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (crypto.timingSafeEqual(sha256(token), sha256(reportToken()))) return true;
  if (token) badLogins.set(ip, [...fails, now]);
  return deny(401, "Wrong password");
}

function handleReport(req, res, url) {
  if (!allowed(req, res)) return;
  const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 14));
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ ...usage.report(days, MONTHLY_VISITS), budget: monthlyBudget(), sonnetBudget: sonnetBudget(), monthlyVisits: MONTHLY_VISITS }));
}

function settingsView() {
  return {
    mode: mode(), modeSetting: process.env.MODE ?? "live",
    anthropicKey: mask(process.env.ANTHROPIC_API_KEY), googleKey: mask(process.env.GOOGLE_TTS_API_KEY),
    elevenKey: mask(process.env.ELEVENLABS_API_KEY), elevenVoice: elevenVoice(), elevenModel: elevenModel(),
    whatsappToken: mask(process.env.WHATSAPP_TOKEN), whatsappPhoneId: process.env.WHATSAPP_PHONE_ID ?? "",
    whatsappTemplate: process.env.WHATSAPP_TEMPLATE || "verification_code", whatsappLang: process.env.WHATSAPP_TEMPLATE_LANG || "en_US",
    freeQuestions: Number(process.env.FREE_QUESTIONS ?? 5), verifiedDaily: Number(process.env.VERIFIED_DAILY ?? 50), verifyOn: verify.on,
    hasPassword: Boolean(reportToken()), sonnetBudget: sonnetBudget(), monthlyBudget: monthlyBudget(),
    spentThisMonth: Math.round(usage.monthSpend * 100) / 100, sonnetSpentThisMonth: Math.round(usage.monthSmartSpend * 100) / 100,
    voice: tts() ?? "browser only",
  };
}

async function handleSettings(req, res) {
  if (!allowed(req, res)) return;
  const json = (code, body) => res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
  if (req.method === "GET") return json(200, settingsView());
  try {
    const b = await readJson(req);
    const changed = saveSettings(ENV_FILE, {
      MODE: b.mode, ANTHROPIC_API_KEY: b.anthropicKey, GOOGLE_TTS_API_KEY: b.googleKey,
      ELEVENLABS_API_KEY: b.elevenKey === "clear" ? null : b.elevenKey, ELEVENLABS_VOICE_ID: b.elevenVoice, ELEVENLABS_MODEL: b.elevenModel,
      SONNET_BUDGET_USD: b.sonnetBudget, MONTHLY_BUDGET_USD: b.monthlyBudget, REPORT_TOKEN: b.password,
      WHATSAPP_TOKEN: b.whatsappToken === "clear" ? null : b.whatsappToken, WHATSAPP_PHONE_ID: b.whatsappPhoneId,
      WHATSAPP_TEMPLATE: b.whatsappTemplate, WHATSAPP_TEMPLATE_LANG: b.whatsappLang,
      FREE_QUESTIONS: b.freeQuestions, VERIFIED_DAILY: b.verifiedDaily,
    });
    if (changed.length) console.log(`Settings changed: ${changed.join(", ")}`);
    json(200, settingsView());
  } catch (err) {
    json(400, { error: err.message });
  }
}

// Checks a saved key without spending anything: listing models and voices is free.
async function handleSettingsTest(req, res, url) {
  if (!allowed(req, res)) return;
  const which = url.searchParams.get("which");
  let ok = false, detail = "", voices;
  try {
    if (which === "anthropic") {
      if (!process.env.ANTHROPIC_API_KEY) throw new Error("No key saved");
      await api().models.list({ limit: 1 });
      ok = true; detail = "Key works";
    } else if (which === "google") {
      if (!process.env.GOOGLE_TTS_API_KEY) throw new Error("No key saved");
      const r = await fetch(`https://texttospeech.googleapis.com/v1/voices?languageCode=hi-IN&key=${encodeURIComponent(process.env.GOOGLE_TTS_API_KEY)}`);
      ok = r.ok; detail = r.ok ? "Key works" : `Google said ${r.status}`;
    } else if (which === "elevenlabs") {
      if (!process.env.ELEVENLABS_API_KEY) throw new Error("No key saved");
      const get = (p) => fetch(`${ELEVENLABS_BASE_URL}${p}`, { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY } });
      const r = await get("/v1/voices");
      if (!r.ok) throw new Error(r.status === 401 ? "ElevenLabs didn't accept this key" : `ElevenLabs said ${r.status}`);
      // Indian-accent voices first, since most customers speak Hindi or Hinglish.
      const indian = (v) => /indian|hindi/i.test(`${v.labels?.accent ?? ""} ${v.labels?.language ?? ""} ${v.name}`);
      voices = ((await r.json()).voices ?? [])
        .map((v) => ({ id: v.voice_id, name: v.name, accent: v.labels?.accent ?? "", gender: v.labels?.gender ?? "", indian: indian(v) }))
        .sort((a, b) => b.indian - a.indian || a.name.localeCompare(b.name));
      ok = true; detail = `Key works · ${voices.length} voices`;
      // Needs the key's "User: read" permission; without it the test still passes.
      const sub = await get("/v1/user/subscription").catch(() => null);
      if (sub?.ok) {
        const s = await sub.json();
        detail += ` · ${s.tier} plan, ${(s.character_limit - s.character_count).toLocaleString("en-IN")} of ${s.character_limit.toLocaleString("en-IN")} credits left this month`;
      }
    } else if (which === "whatsapp") {
      if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_ID) throw new Error("Save the access token and phone number ID first");
      // Reading the number's own details sends nothing and costs nothing.
      const r = await fetch(`https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION ?? "v27.0"}/${encodeURIComponent(process.env.WHATSAPP_PHONE_ID)}?fields=display_phone_number,verified_name,quality_rating`, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`WhatsApp said: ${j.error?.message ?? r.status}`);
      ok = true; detail = `Works · sending from ${j.display_phone_number} (${j.verified_name}) · quality ${j.quality_rating ?? "unknown"}`;
    } else if (which === "demo") {
      const out = await new Promise((resolve) => {
        const child = spawn(CLI, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
        let text = "";
        child.stdout.on("data", (c) => (text += c));
        child.on("error", () => resolve(null));
        child.on("close", (code) => resolve(code === 0 ? text.trim() : null));
      });
      ok = Boolean(out); detail = out ? `Claude app found (${out})` : "Claude app not found on this computer";
    }
  } catch (err) {
    detail = err instanceof Anthropic.APIError ? `Anthropic said ${err.status}` : err.message;
  }
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok, detail, voices }));
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css" };

const server = http.createServer(async (req, res) => {
  cors(req, res);
  const url = new URL(req.url, "http://localhost");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  if (req.method === "POST" && url.pathname === "/api/chat") return handleChat(req, res);
  if (req.method === "POST" && url.pathname === "/api/tts") return handleTts(req, res);
  if (req.method === "POST" && url.pathname === "/api/event") return handleEvent(req, res);
  if (req.method === "POST" && url.pathname === "/api/verify/send") return handleVerify(req, res, "send");
  if (req.method === "POST" && url.pathname === "/api/verify/confirm") return handleVerify(req, res, "confirm");
  if (req.method === "GET" && url.pathname === "/api/report") return handleReport(req, res, url);
  if (url.pathname === "/api/settings" && (req.method === "GET" || req.method === "POST")) return handleSettings(req, res);
  if (req.method === "POST" && url.pathname === "/api/settings/test") return handleSettingsTest(req, res, url);
  if (req.method === "GET" && url.pathname === "/api/product") {
    const d = index.product(url.searchParams.get("url"));
    if (!d) return res.writeHead(404, { "Content-Type": "application/json" }).end("{}");
    const { title, url: link, productId, category, image, price, mrp, discountPct, inStock, variants, keyFeatures, specs, description, warranty } = d;
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" });
    return res.end(JSON.stringify({ title, url: link, productId, category, image, price, mrp, discountPct, inStock, variants, keyFeatures, specs, description, warranty }));
  }
  if (req.method === "GET" && url.pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, pages: index.size, model: MODEL, fastModel: ROUTING ? FAST_MODEL : null, mode: mode(), tts: tts() ?? false }));
  }
  if (req.method === "GET") {
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const full = path.join(PUBLIC, path.normalize(file));
    if (full.startsWith(PUBLIC) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, { "Content-Type": TYPES[path.extname(full)] ?? "application/octet-stream" });
      return fs.createReadStream(full).pipe(res);
    }
  }
  res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
});

server.listen(PORT, HOST, () => {
  console.log(`Chat server on http://localhost:${PORT}  (${index.size} pages indexed, model ${MODEL}${ROUTING ? `, simple questions on ${FAST_MODEL}` : ""})`);
  if (!index.size) console.warn("No scraped data yet - run `npm run scrape` first.");
  warmCli();
});
