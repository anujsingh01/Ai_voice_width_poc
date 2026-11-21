// Ready answers for first questions customers ask again and again ("best
// offers?", "5 litre cooker"), so they appear at once instead of in seconds.
//
// An answer is only reused while everything it was written from is unchanged:
// each one is stored with a fingerprint of the store search results it was
// based on (prices, MRP, discounts, stock, the product list itself) and of the
// prompt. Every request runs the searches again (a couple of milliseconds) and
// compares; any change in the catalogue means a fresh answer. Answers older
// than a day are dropped as well.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const MAX_AGE = 24 * 3600e3;
// Possible personal details (emails, phone or order numbers): never stored.
const PRIVATE = /@|\d{6,}|\+\s?91/;

export const fingerprint = (...parts) => crypto.createHash("sha1").update(parts.join("\u0000")).digest("hex");

// "Best offers??" and "best offers" are the same question; anything long or
// possibly personal isn't stored at all.
export const normalize = (text) => String(text).toLowerCase().normalize("NFC").replace(/[^\p{L}\p{M}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();
export function questionKey(text) {
  const t = normalize(text);
  return t && t.length <= 120 && !PRIVATE.test(text) ? t : null;
}

export class AnswerCache {
  constructor(file, size = 2000) {
    this.file = file;
    this.size = size;
    this.map = new Map();
    try {
      for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(file, "utf8")))) this.map.set(k, v);
    } catch {}
  }

  // The stored answer, only if it was written from exactly these inputs.
  get(key, inputs) {
    const e = this.map.get(key);
    if (!e) return null;
    if (e.inputs !== inputs || Date.now() - e.at > MAX_AGE) {
      this.map.delete(key);
      this.dirty();
      return null;
    }
    e.hits++;
    this.dirty();
    return e.text;
  }

  set(key, inputs, text) {
    const old = this.map.get(key);
    this.map.delete(key);
    if (this.map.size >= this.size) this.map.delete(this.map.keys().next().value);
    this.map.set(key, { inputs, text, at: Date.now(), hits: old?.hits ?? 0 });
    this.dirty();
  }

  // Questions asked more than once, for the nightly warm-up.
  popular(n = 100) {
    return [...this.map.entries()].filter(([, e]) => e.hits > 0).sort((a, b) => b[1].hits - a[1].hits).slice(0, n).map(([k]) => k);
  }

  dirty() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFile(tmp, JSON.stringify(Object.fromEntries(this.map)), (err) => (err ? console.error("Answer cache save failed:", err.message) : fs.rename(tmp, this.file, () => {})));
    }, 2000);
    this.timer.unref?.();
  }
}
