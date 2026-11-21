// Settings that can be changed from /admin.html while the server runs: the mode
// (demo through the Claude app, or live through the API), the keys and the
// budgets. Saved to .env so a restart keeps them; keys are never sent back to
// the browser, only their last four characters.

import fs from "node:fs";

const FIELDS = {
  MODE: /^(demo|live)$/,
  ANTHROPIC_API_KEY: /^[\w-]{20,200}$/,
  GOOGLE_TTS_API_KEY: /^[\w-]{20,200}$/,
  ELEVENLABS_API_KEY: /^[\w-]{20,200}$/,
  ELEVENLABS_VOICE_ID: /^[A-Za-z0-9]{10,40}$/,
  ELEVENLABS_MODEL: /^eleven_[a-z0-9_]{2,40}$/,
  SONNET_BUDGET_USD: /^\d{1,6}(\.\d{1,2})?$/,
  MONTHLY_BUDGET_USD: /^\d{1,6}(\.\d{1,2})?$/,
  REPORT_TOKEN: /^\S{8,200}$/,
  WHATSAPP_TOKEN: /^[\w-]{20,600}$/,
  WHATSAPP_PHONE_ID: /^\d{6,30}$/,
  WHATSAPP_TEMPLATE: /^[a-z0-9_]{1,512}$/,
  WHATSAPP_TEMPLATE_LANG: /^[a-z]{2,3}(_[A-Z]{2})?$/,
  FREE_QUESTIONS: /^\d{1,3}$/,
  VERIFIED_DAILY: /^\d{1,4}$/,
};
const SECRET = new Set(["ANTHROPIC_API_KEY", "GOOGLE_TTS_API_KEY", "ELEVENLABS_API_KEY", "WHATSAPP_TOKEN", "REPORT_TOKEN"]);

export const mask = (v) => (v ? `••••${v.slice(-4)}` : null);

// Updates process.env and .env. A value of "" leaves a field as it is; null clears it.
export function saveSettings(file, updates) {
  const changes = {};
  for (const [k, v] of Object.entries(updates)) {
    if (!(k in FIELDS) || v === "" || v === undefined) continue;
    if (v !== null && !FIELDS[k].test(String(v).trim())) throw new Error(`${k} doesn't look right`);
    changes[k] = v === null ? null : String(v).trim();
  }
  if (!Object.keys(changes).length) return [];
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n") : [];
  const seen = new Set();
  const out = lines.flatMap((line) => {
    const k = line.match(/^\s*([A-Z_]+)\s*=/)?.[1];
    if (!k || !(k in changes)) return [line];
    seen.add(k);
    return changes[k] === null ? [] : [`${k}=${changes[k]}`];
  });
  for (const [k, v] of Object.entries(changes)) if (!seen.has(k) && v !== null) out.push(`${k}=${v}`);
  fs.writeFileSync(file, out.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) delete process.env[k];
    else process.env[k] = v;
  }
  return Object.keys(changes).map((k) => (SECRET.has(k) ? `${k} (${changes[k] ? mask(changes[k]) : "cleared"})` : `${k}=${changes[k]}`));
}
