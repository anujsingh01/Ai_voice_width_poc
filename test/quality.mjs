// Quality test: asks the running assistant real customer questions
// (test/questions.json) and checks every answer against the catalogue.
//   npm run quality                      # against http://localhost:3030
//   npm run quality -- http://host:port
//   npm run quality -- http://localhost:3030 cooker-4,gift   # only these questions
// Checks: product answers recommend a product and end with a next step (sales), links are real store pages, every ₹ price matches a linked product,
// out-of-stock products are called out, no "all/most models" claims, only the
// real customer-care numbers, no stock bot phrases, and replies stay short.
// Answers and flags go to data/quality/<time>.json for a person to read.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = process.argv[2] ?? "http://localhost:3030";
const only = process.argv[3]?.split(",");
const questions = JSON.parse(fs.readFileSync(path.join(root, "test", "questions.json"), "utf8")).filter((q) => !only || only.includes(q.id));
const catalog = JSON.parse(fs.readFileSync(path.join(root, "data", "catalog.json"), "utf8"));
const byUrl = new Map(catalog.map((d) => [d.url.split("#")[0], d]));
const PHONES = new Set(["919535621112", "9535621112", "08046824000", "8046824000"]);
const ROBOTIC = /great question|certainly!|i'd be happy to help|i would be happy to help|let me know if you have any other questions|as an ai language model|i hope this helps/i;
const STORE_CLAIM = /\b(range|ranges|start|starts) from ₹[\d,]+ to ₹|we('ve| have) got (two|three|four|five|\d+)\b|\bmost affordable\b|here are (the|all|our) [^.]{0,40}\bwe have\b/i;
const BRAND_CLAIM = /\ball (the |of the |our )?(prestige |[a-z]+ ){0,4}(pans|cookers|tawas|kadais|stoves|mixers|cooktops|products|models)\b/i;
const RANGE_CLAIM = /\b(all|most|every one) (of )?(our |the |prestige |these |its )?(svachh |nakshatra |popular |deluxe )?(cookers|models|products|variants|sizes|range|stoves|ones)\b|\bmost of them\b|\ball of them\b/i;

const prices = (d) => [d.price, d.mrp, ...(d.variants ?? []).flatMap((v) => [v.price, v.mrp])].filter(Boolean);
const fullyOut = (d) => d.kind === "product" && !d.inStock && !(d.variants ?? []).some((v) => v.inStock);

function check(reply, turns, voice, sell) {
  const flags = [];
  // Sales: a product question should end with a recommendation and a next step.
  if (sell) {
    const recommends = voice ? /₹|rupees?|रुपये/i.test(reply) : /\]\(https:\/\/shop\.ttkprestige\.com\/[^)]+\)/.test(reply);
    if (!recommends) flags.push("sales: no product recommended");
    const end = reply.trim().split(/(?<=[.!?।])\s+/).slice(-2).join(" ");
    if (!/\?|cart|add it|tap the|checkout|let me know|tell me|batayei?n|bataiye|bata(o|na)|boliye|add kar|कार्ट|बताइ|बोलिए/i.test(end)) flags.push("sales: no next step at the end");
  }
  const links = [...reply.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1].split("#")[0]);
  const linked = [];
  for (const u of links) {
    const d = byUrl.get(u);
    if (!d) flags.push(`link not a store page: ${u}`);
    else linked.push(d);
  }
  const allowed = new Set(linked.flatMap(prices));
  for (const t of turns) for (const m of t.matchAll(/(\d[\d,]{2,})/g)) allowed.add(Number(m[1].replace(/,/g, "")));
  for (const m of reply.matchAll(/₹\s?(\d[\d,]*)/g)) {
    const n = Number(m[1].replace(/,/g, ""));
    if (!allowed.has(n)) {
      // Without a link (e.g. a product named in passing), accept a price some catalogue product has.
      const known = catalog.some((d) => prices(d).includes(n));
      flags.push(known ? `price ₹${n} not from a linked product (check which product)` : `price ₹${n} matches no product`);
    }
  }
  for (const d of linked) {
    if (fullyOut(d) && !/out of stock|not in stock|stock (mein|me) nahi|unavailable|not available|sold out/i.test(reply)) flags.push(`recommends out-of-stock: ${d.title.slice(0, 60)}`);
  }
  if (RANGE_CLAIM.test(reply)) flags.push(`range claim: "${reply.match(RANGE_CLAIM)[0]}"`);
  for (const m of reply.matchAll(/(\+?\d[\d\s-]{8,}\d)/g)) {
    const digits = m[1].replace(/\D/g, "");
    if (digits.length >= 10 && !PHONES.has(digits)) flags.push(`unknown phone number: ${m[1]}`);
  }
  if (BRAND_CLAIM.test(reply)) flags.push(`range claim: "${reply.match(BRAND_CLAIM)[0]}"`);
  if (STORE_CLAIM.test(reply)) flags.push(`store-wide claim: "${reply.match(STORE_CLAIM)[0]}"`);
  if (ROBOTIC.test(reply)) flags.push(`bot phrase: "${reply.match(ROBOTIC)[0]}"`);
  const words = reply.split(/\s+/).filter(Boolean).length;
  if (voice) {
    if (/\]\(|https?:|\*\*|^\s*[-•]/m.test(reply)) flags.push("voice reply has links or formatting");
    if (words > 70) flags.push(`voice reply long (${words} words)`);
  } else if (words > 170) flags.push(`long reply (${words} words)`);
  if (/having trouble answering|something went wrong|not available right now/i.test(reply)) flags.push("error reply");
  return { flags, words };
}

async function ask(messages, mode, visitor) {
  const t0 = performance.now();
  let first = 0, text = "";
  const r = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, mode: mode ?? "text", visitor }),
  });
  const rd = r.body.getReader(), dec = new TextDecoder();
  for (;;) {
    const x = await rd.read();
    if (x.done) break;
    if (!first) first = performance.now();
    text += dec.decode(x.value, { stream: true });
  }
  const shown = text.slice(text.lastIndexOf("\u001f") + 1); // what the widget shows after a search
  return { reply: shown.split("\u001e")[0].trim(), firstSec: +((first - t0) / 1000).toFixed(1), totalSec: +((performance.now() - t0) / 1000).toFixed(1) };
}

const results = [];
for (const [i, q] of questions.entries()) {
  const visitor = `qualitytest${String(i).padStart(3, "0")}`;
  const messages = [];
  const replies = [];
  for (const turn of q.turns) {
    messages.push({ role: "user", content: turn });
    const { reply, firstSec, totalSec } = await ask(messages, q.mode, visitor);
    messages.push({ role: "assistant", content: reply || "(empty)" });
    replies.push({ turn, reply, firstSec, totalSec, ...check(reply, q.turns, q.mode === "voice", q.sell !== false) });
  }
  const flags = replies.flatMap((r) => r.flags);
  results.push({ id: q.id, turns: replies, flags });
  console.log(`${flags.length ? "CHECK" : "ok   "}  ${q.id.padEnd(18)} ${replies.map((r) => `${r.firstSec}/${r.totalSec}s`).join(" ")}  ${flags.join(" | ")}`);
}

const outDir = path.join(root, "data", "quality");
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(file, JSON.stringify(results, null, 1));
const flagged = results.filter((r) => r.flags.length).length;
console.log(`\n${results.length - flagged} of ${results.length} passed the automatic checks; ${flagged} to read. Answers: ${path.relative(root, file)}`);
