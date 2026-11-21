// WhatsApp number check after the first few questions, so one person can't run
// up the bill with an endless chat. Everyone gets FREE_QUESTIONS a day; after
// that the widget asks for a WhatsApp number, we send a 6-digit code through
// the WhatsApp Cloud API (an approved "authentication" template), and a
// confirmed number gets VERIFIED_DAILY questions a day.
//
// Only a keyed hash of each number is kept, never the number itself. Codes are
// hashed too, live 5 minutes and allow 5 tries. Sends are capped per number,
// per address and per day, so the codes themselves can't be abused.
//
// Off until WhatsApp is set up in /admin.html. WHATSAPP_DEV=on (this computer
// only) prints codes to the server console instead of sending them.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const freeQuestions = () => Number(process.env.FREE_QUESTIONS ?? 5);
const verifiedDaily = () => Number(process.env.VERIFIED_DAILY ?? 50);
// Unverified questions from one address a day: several shoppers can share a
// mobile network address, but clearing the browser doesn't give endless chats.
const FREE_PER_IP = 40;
const CODE_MS = 5 * 60e3;
const TRIES = 5;
const RESEND_MS = 30e3;
const SENDS_PER_NUMBER = 3; // an hour
const SENDS_PER_IP = 6; // an hour
const sendsPerDay = () => Number(process.env.WHATSAPP_DAILY_CAP ?? 1000);
const TOKEN_DAYS = 30;
const API_VERSION = process.env.WHATSAPP_API_VERSION ?? "v27.0";

const day = (t = Date.now()) => new Date(t + 5.5 * 3600e3).toISOString().slice(0, 10); // India time
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

export const whatsappReady = () => Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID) || process.env.WHATSAPP_DEV === "on";

// Indian mobile numbers only: 10 digits starting 6-9, with or without +91 / 0.
export function indianMobile(raw) {
  const d = String(raw ?? "").replace(/[\s()-]/g, "").replace(/^(\+?91|0)(?=\d{10}$)/, "");
  return /^[6-9]\d{9}$/.test(d) ? `91${d}` : null;
}

export class Verify {
  constructor(dir) {
    this.file = path.join(dir, "verify.json");
    fs.mkdirSync(dir, { recursive: true });
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch {}
    this.secret = saved.secret ?? crypto.randomBytes(32).toString("hex");
    this.tokens = new Map(Object.entries(saved.tokens ?? {})); // sha(token) -> { phone: hash, until }
    this.day = saved.day ?? day();
    this.counts = new Map(saved.day === day() ? Object.entries(saved.counts ?? {}) : []); // "v:id" / "ip:addr" / "p:hash" -> questions today
    this.sentToday = saved.day === day() ? saved.sentToday ?? 0 : 0;
    this.codes = new Map(); // phone hash -> { code: hash, until, tries, at }
    this.sends = new Map(); // "p:hash" / "ip:addr" -> send times this hour
    if (!saved.secret) this.dirty();
  }

  get on() {
    return whatsappReady() && freeQuestions() > 0;
  }

  phoneHash(phone) {
    return crypto.createHmac("sha256", this.secret).update(phone).digest("hex");
  }

  rollDay() {
    if (this.day === day()) return;
    Object.assign(this, { day: day(), counts: new Map(), sentToday: 0 });
  }

  // Whether this question may be answered: "ok", "verify" (ask for a number)
  // or "limit" (a confirmed number has used today's questions).
  check({ visitor, ip, token }) {
    if (!this.on) return { status: "ok" };
    this.rollDay();
    const phone = this.tokenPhone(token);
    if (phone) return { status: (this.counts.get(`p:${phone}`) ?? 0) < verifiedDaily() ? "ok" : "limit", phone };
    const v = this.counts.get(`v:${visitor}`) ?? 0;
    const i = this.counts.get(`ip:${ip}`) ?? 0;
    return { status: v < freeQuestions() && i < FREE_PER_IP ? "ok" : "verify" };
  }

  // Counts a question that is being answered.
  count({ visitor, ip, phone }) {
    if (!this.on) return;
    this.rollDay();
    const keys = phone ? [`p:${phone}`] : [`v:${visitor}`, `ip:${ip}`];
    for (const k of keys) this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
    this.dirty();
  }

  tokenPhone(token) {
    if (typeof token !== "string" || token.length !== 64) return null;
    const t = this.tokens.get(sha(token));
    if (!t || t.until < Date.now()) return null;
    return t.phone;
  }

  // Sends a code. Returns { ok } or { error } in words the shopper can read.
  async send(rawPhone, ip) {
    if (!this.on) return { error: "Verification isn't switched on." };
    const phone = indianMobile(rawPhone);
    if (!phone) return { error: "Please enter a 10-digit Indian mobile number." };
    const h = this.phoneHash(phone);
    const now = Date.now();
    // Expired codes and old send times are forgotten.
    for (const [k, c] of this.codes) if (c.until < now) this.codes.delete(k);
    for (const [k, times] of this.sends) if (now - times.at(-1) > 3600e3) this.sends.delete(k);
    const last = this.codes.get(h);
    if (last && now - last.at < RESEND_MS) return { error: "A code was just sent. Please wait half a minute before asking again." };
    const recent = (k) => (this.sends.get(k) ?? []).filter((t) => now - t < 3600e3);
    if (recent(`p:${h}`).length >= SENDS_PER_NUMBER || recent(`ip:${ip}`).length >= SENDS_PER_IP) return { error: "Too many codes asked for. Please try again in an hour." };
    this.rollDay();
    if (this.sentToday >= sendsPerDay()) return { error: "We can't send codes right now. Please try again tomorrow, or call +91 95356 21112." };

    const code = String(crypto.randomInt(0, 1e6)).padStart(6, "0");
    const sent = await deliver(phone, code);
    if (!sent.ok) return { error: sent.error };
    this.codes.set(h, { code: sha(`${h}:${code}`), until: now + CODE_MS, tries: 0, at: now });
    for (const k of [`p:${h}`, `ip:${ip}`]) this.sends.set(k, [...recent(k), now]);
    this.sentToday++;
    this.dirty();
    return { ok: true };
  }

  // Checks a code. Returns { token } (kept by the widget) or { error }.
  confirm(rawPhone, code) {
    const phone = indianMobile(rawPhone);
    const h = phone && this.phoneHash(phone);
    const c = h && this.codes.get(h);
    if (!c || c.until < Date.now()) return { error: "This code has expired or was already used. Please ask for a new one." };
    if (++c.tries > TRIES) {
      this.codes.delete(h);
      return { error: "Too many wrong tries. Please ask for a new code." };
    }
    if (!/^\d{6}$/.test(String(code ?? "").trim()) || sha(`${h}:${String(code).trim()}`) !== c.code) return { error: "That code doesn't match. Please check the WhatsApp message." };
    this.codes.delete(h);
    const token = crypto.randomBytes(32).toString("hex");
    this.tokens.set(sha(token), { phone: h, until: Date.now() + TOKEN_DAYS * 86400e3 });
    for (const [k, t] of this.tokens) if (t.until < Date.now()) this.tokens.delete(k);
    this.dirty();
    return { token };
  }

  dirty() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const tmp = `${this.file}.tmp`;
      const data = { secret: this.secret, day: this.day, sentToday: this.sentToday, counts: Object.fromEntries(this.counts), tokens: Object.fromEntries(this.tokens) };
      fs.writeFile(tmp, JSON.stringify(data), { mode: 0o600 }, (err) => (err ? console.error("Verify save failed:", err.message) : fs.rename(tmp, this.file, () => {})));
    }, 1000);
    this.timer.unref?.();
  }
}

// The WhatsApp Cloud API with a copy-code authentication template: the code
// goes in the body and in the button.
async function deliver(phone, code) {
  if (process.env.WHATSAPP_DEV === "on" && !process.env.WHATSAPP_TOKEN) {
    console.log(`WhatsApp code for ••••${phone.slice(-4)}: ${code} (WHATSAPP_DEV, not sent)`);
    return { ok: true };
  }
  const param = [{ type: "text", text: code }];
  try {
    const r = await fetch(`https://graph.facebook.com/${API_VERSION}/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp", recipient_type: "individual", to: phone, type: "template",
        template: {
          name: process.env.WHATSAPP_TEMPLATE || "verification_code",
          language: { code: process.env.WHATSAPP_TEMPLATE_LANG || "en_US" },
          components: [{ type: "body", parameters: param }, { type: "button", sub_type: "url", index: "0", parameters: param }],
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (r.ok) return { ok: true };
    const err = (await r.json().catch(() => ({}))).error ?? {};
    console.error(`WhatsApp send failed: ${r.status} ${err.code ?? ""} ${err.message ?? ""}`);
    // 131026: the number isn't on WhatsApp (or can't receive this message).
    if (err.code === 131026) return { error: "This number doesn't seem to be on WhatsApp. Please check it." };
    return { error: "We couldn't send the code just now. Please try again in a minute." };
  } catch (err) {
    console.error("WhatsApp send failed:", err.message);
    return { error: "We couldn't send the code just now. Please try again in a minute." };
  }
}
