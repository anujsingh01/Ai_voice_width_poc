// Counts what the pilot needs to replace the published 1–3% reference with our
// own numbers: visitors who saw the chat button, who opened it, who chatted,
// and what each reply cost. One JSON line per event in data/usage/<date>.jsonl.
// Visitors are a random id the widget makes; no names, no message text.

import fs from "node:fs";
import path from "node:path";

// US dollars per million tokens (Anthropic list prices). Cache reads cost 10%
// of input, cache writes 125%.
const PRICES = {
  "claude-sonnet-5-5": { in: 2, out: 10 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5 },
  "claude-opus-5-5": { in: 4, out: 20 },
};
const CLI_ALIASES = { sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5", opus: "claude-opus-5-5" };

export function costOf(model, u = {}) {
  const p = PRICES[CLI_ALIASES[model] ?? model];
  if (!p) return 0;
  const inTok = (u.input_tokens ?? 0) + 0.1 * (u.cache_read_input_tokens ?? 0) + 1.25 * (u.cache_creation_input_tokens ?? 0);
  return (inTok * p.in + (u.output_tokens ?? 0) * p.out) / 1e6;
}

const day = (t = Date.now()) => new Date(t + 5.5 * 3600e3).toISOString().slice(0, 10); // India time
const ID = /^[a-z0-9]{8,40}$/;
export const WARMUP = "warmupnightly";

export class Usage {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.monthKey = day().slice(0, 7);
    const month = this.read(31).filter((e) => e.type === "msg" && day(e.t).startsWith(this.monthKey));
    this.monthSpend = month.reduce((s, e) => s + e.cost, 0);
    // What the smart model (Sonnet) has used, for its own monthly budget.
    this.monthSmartSpend = month.filter((e) => e.tier === "smart").reduce((s, e) => s + e.cost, 0);
  }

  // Widget events: "view" (chat button shown, once a visitor a day) and "open".
  event(type, visitor) {
    if (!["view", "open"].includes(type) || !ID.test(String(visitor))) return false;
    this.write({ t: Date.now(), type, v: visitor });
    return true;
  }

  // One reply: which model, how many tokens, what it cost, how long it took.
  message({ visitor, tier, model, mode, usage, firstMs, totalMs }) {
    const cost = costOf(model, usage);
    const month = day().slice(0, 7);
    if (month !== this.monthKey) Object.assign(this, { monthKey: month, monthSpend: 0, monthSmartSpend: 0 });
    this.monthSpend += cost;
    if (tier === "smart") this.monthSmartSpend += cost;
    this.write({
      t: Date.now(), type: "msg", v: ID.test(String(visitor)) ? visitor : "unknown", tier, model, mode,
      in: usage?.input_tokens ?? 0, cacheRead: usage?.cache_read_input_tokens ?? 0,
      cacheWrite: usage?.cache_creation_input_tokens ?? 0, out: usage?.output_tokens ?? 0,
      cost: Math.round(cost * 1e6) / 1e6, firstMs, totalMs,
    });
  }

  // The WhatsApp number check: "gate" (asked to verify), "otp" (code sent),
  // "verified". Each code sent is a paid WhatsApp authentication message.
  verify(type, visitor) {
    this.write({ t: Date.now(), type, v: ID.test(String(visitor)) ? visitor : "unknown" });
  }

  // A ready answer sent from the answer cache (cache.js): no model, no cost.
  ready({ visitor, mode, firstMs }) {
    this.write({ t: Date.now(), type: "ready", v: ID.test(String(visitor)) ? visitor : "unknown", mode, firstMs });
  }

  write(entry) {
    fs.appendFile(path.join(this.dir, `${day(entry.t)}.jsonl`), JSON.stringify(entry) + "\n", (err) => {
      if (err) console.error("Usage log write failed:", err.message);
    });
  }

  read(days) {
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const file = path.join(this.dir, `${day(Date.now() - i * 86400e3)}.jsonl`);
      if (!fs.existsSync(file)) continue;
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        try { if (line) out.push(JSON.parse(line)); } catch {}
      }
    }
    return out;
  }

  // Per-day and total figures for the report page.
  report(days = 14, monthlyVisits = null) {
    const events = this.read(days);
    const byDay = new Map();
    const get = (d) => byDay.get(d) ?? byDay.set(d, { day: d, viewers: new Set(), openers: new Set(), chatters: new Set(), gated: new Set(), otp: 0, verified: 0, messages: 0, fast: 0, ready: 0, cost: 0, firstMs: [] }).get(d);
    for (const e of events) {
      // The nightly warm-up (npm run warm) isn't a customer; its cost still counts.
      if (e.v === WARMUP && e.type !== "msg") continue;
      const r = get(day(e.t));
      if (e.type === "view") r.viewers.add(e.v);
      else if (e.type === "open") r.openers.add(e.v);
      else if (e.type === "gate") r.gated.add(e.v);
      else if (e.type === "otp") r.otp++;
      else if (e.type === "verified") r.verified++;
      else if (e.type === "ready") {
        r.chatters.add(e.v);
        r.messages++;
        r.ready++;
        if (e.firstMs) r.firstMs.push(e.firstMs);
      } else if (e.type === "msg" && e.v === WARMUP) {
        r.cost += e.cost;
      } else if (e.type === "msg") {
        r.chatters.add(e.v);
        r.messages++;
        if (e.tier === "fast") r.fast++;
        r.cost += e.cost;
        if (e.firstMs) r.firstMs.push(e.firstMs);
      }
    }
    const rows = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).map((r) => ({
      day: r.day, visitors: r.viewers.size, opened: r.openers.size, chatted: r.chatters.size,
      messages: r.messages, askedToVerify: r.gated.size, codesSent: r.otp, verified: r.verified, onHaiku: r.fast, ready: r.ready, cost: round(r.cost, 2), medianFirstWordsSec: median(r.firstMs) / 1000,
    }));
    const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
    const t = { visitors: sum("visitors"), opened: sum("opened"), chatted: sum("chatted"), messages: sum("messages"), askedToVerify: sum("askedToVerify"), codesSent: sum("codesSent"), verified: sum("verified"), onHaiku: sum("onHaiku"), ready: sum("ready"), cost: round(sum("cost"), 2) };
    const chatShare = t.visitors ? t.chatted / t.visitors : null;
    const costPerChat = t.chatted ? t.cost / t.chatted : null;
    return {
      days: rows.length, rows,
      totals: {
        ...t,
        openShare: t.visitors ? round(t.opened / t.visitors, 4) : null,
        chatShare: chatShare == null ? null : round(chatShare, 4),
        messagesPerChat: t.chatted ? round(t.messages / t.chatted, 2) : null,
        haikuShare: t.messages ? round(t.onHaiku / t.messages, 4) : null,
        readyShare: t.messages ? round(t.ready / t.messages, 4) : null,
        costPerChat: costPerChat == null ? null : round(costPerChat, 4),
        // Our measured chat share and cost per chat applied to the Semrush
        // monthly average, the same traffic the cost plan used.
        forecastMonthly: chatShare != null && costPerChat != null && monthlyVisits ? round(monthlyVisits * chatShare * costPerChat, 0) : null,
        monthToDateSpend: round(this.monthSpend, 2),
        sonnetMonthToDateSpend: round(this.monthSmartSpend, 2),
      },
    };
  }
}

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
const median = (a) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
