// Nightly warm-up (npm run warm), run after the price refresh: asks the
// server the common first questions, in text and voice, so their ready
// answers (cache.js) are written from tonight's prices before customers ask.
// Questions whose store data hasn't changed come back from the cache and cost
// nothing. The list is server/starters.json plus the questions customers
// asked more than once (from the answer cache, which stores no personal data).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WARMUP } from "./usage.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = process.argv[2] ?? `http://localhost:${process.env.PORT ?? 3030}`;
const starters = JSON.parse(fs.readFileSync(path.join(here, "starters.json"), "utf8"));
let popular = [];
try {
  const stored = JSON.parse(fs.readFileSync(path.join(here, "..", "data", "cache", "answers.json"), "utf8"));
  popular = Object.entries(stored).filter(([, e]) => e.hits > 0).sort((a, b) => b[1].hits - a[1].hits).slice(0, 100).map(([k]) => k.split("|").slice(1).join("|"));
} catch {}
const questions = [...new Set([...starters.map((q) => q.toLowerCase()), ...popular])];

let fresh = 0, ready = 0, failed = 0;
for (const q of questions) {
  for (const mode of ["text", "voice"]) {
    const t = Date.now();
    try {
      const r = await fetch(`${server}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: q }], mode, visitor: WARMUP }),
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const ms = Date.now() - t;
      ms < 1000 ? ready++ : fresh++;
      console.log(`${ms < 1000 ? "ready" : "fresh"}  ${mode.padEnd(5)} ${(ms / 1000).toFixed(1)}s  ${q}${text.length < 30 ? `  (short reply: ${JSON.stringify(text)})` : ""}`);
      // Stay under the server's limit of 20 chats a minute.
      await new Promise((r) => setTimeout(r, 3200));
    } catch (err) {
      failed++;
      console.log(`failed ${mode.padEnd(5)} ${q}: ${err.message}`);
    }
  }
}
console.log(`\n${questions.length} questions: ${fresh} written fresh, ${ready} still current, ${failed} failed.`);
