// Crawls shop.ttkprestige.com product + info pages listed in its sitemaps and
// saves the useful part of each page's HTML (gzipped) to data/raw/. Cleaning
// happens separately in scraper/clean.js, so it can be improved and re-run
// without crawling the site again.
//
// Usage:
//   node scraper/scrape.js                 # full crawl, honours robots.txt crawl-delay (10s)
//   node scraper/scrape.js --limit 20      # only the first 20 new pages (quick test)
//   node scraper/scrape.js --delay 10      # seconds between requests
//   node scraper/scrape.js --fresh         # re-fetch pages already saved (to pick up price changes)
//
// The crawl is resumable: pages already saved are skipped. Every 25 pages, and
// at the end, it runs the cleaner so the chat server can pick up new products.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildCatalog } from "./clean.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "..", "data");
const RAW = path.join(DATA, "raw");
const INDEX = path.join(DATA, "pages.json");
const BASE = "https://shop.ttkprestige.com";
const SITEMAPS = [
  { url: `${BASE}/media/sitemap/sitemap_product.xml`, kind: "product" },
  { url: `${BASE}/media/sitemap/sitemap_cms.xml`, kind: "page" },
];
const UA = "Mozilla/5.0 (compatible; PrestigeAssistantBot/1.0)";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const LIMIT = Number(flag("limit", Infinity));
const DELAY_S = Number(flag("delay", 10));
const FRESH = args.includes("--fresh");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
      if (res.status === 404 || res.status === 410) return null;
      // Being rate limited or blocked: back off hard rather than keep hitting the site.
      if (res.status === 429 || res.status === 403 || res.status === 503) {
        const wait = Number(res.headers.get("retry-after")) || 60 * attempt;
        console.warn(`  HTTP ${res.status}, backing off ${wait}s`);
        await sleep(wait * 1000);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(10_000 * attempt);
    }
  }
  throw new Error("still blocked after 3 attempts");
}

// Keep only what the cleaner needs: head metadata, the main content, and the
// configurable-product JSON (variant prices, sizes, stock). ~10x smaller.
function trim(html) {
  const parts = [];
  const head = html.match(/<head[\s\S]*?<\/head>/i)?.[0] ?? "";
  for (const m of head.matchAll(/<title>[\s\S]*?<\/title>|<meta [^>]*>|<script type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/gi)) {
    parts.push(m[0]);
  }
  const start = html.indexOf('id="maincontent"');
  if (start >= 0) {
    const end = html.indexOf("<footer", start);
    parts.push(html.slice(html.lastIndexOf("<", start), end > start ? end : undefined)
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<svg[\s\S]*?<\/svg>/gi, ""));
  }
  for (const m of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (/"optionPrices"|"jsonSwatchConfig"|"jsonConfig"/.test(m[1])) parts.push(m[0]);
  }
  return parts.join("\n");
}

async function sitemapUrls() {
  const list = [];
  for (const sm of SITEMAPS) {
    const xml = await get(sm.url);
    if (!xml) continue;
    for (const [, loc] of xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>/g)) {
      // robots.txt disallows /catalog/ and query strings.
      if (loc.includes("/catalog/") || loc.includes("?")) continue;
      list.push({ url: loc.trim(), kind: sm.kind });
    }
  }
  return list;
}

function rebuild() {
  try {
    const { products, pages } = buildCatalog();
    console.log(`  catalogue rebuilt: ${products} products, ${pages} info pages`);
  } catch (err) {
    console.warn(`  catalogue rebuild failed: ${err.message}`);
  }
}

async function main() {
  fs.mkdirSync(RAW, { recursive: true });
  const index = fs.existsSync(INDEX) ? JSON.parse(fs.readFileSync(INDEX, "utf8")) : {};

  const urls = await sitemapUrls();
  const todo = urls.filter((u) => FRESH || !index[u.url]).slice(0, LIMIT);
  const etaMin = Math.round((todo.length * DELAY_S) / 60);
  console.log(`${urls.length} URLs in sitemaps, ${Object.keys(index).length} already saved, ${todo.length} to fetch (~${etaMin} min at ${DELAY_S}s delay)`);

  let done = 0, failed = 0;
  for (const { url, kind } of todo) {
    done++;
    try {
      const html = await get(url);
      if (html) {
        const file = crypto.createHash("sha1").update(url).digest("hex").slice(0, 16) + ".html.gz";
        fs.writeFileSync(path.join(RAW, file), zlib.gzipSync(trim(html)));
        index[url] = { kind, file, fetchedAt: new Date().toISOString() };
        const title = html.match(/<span class="base"[^>]*>([^<]*)</)?.[1]?.trim() || url;
        console.log(`[${done}/${todo.length}] ${title}`);
      } else {
        delete index[url];
        console.log(`[${done}/${todo.length}] gone (404) ${url}`);
      }
    } catch (err) {
      failed++;
      console.warn(`[${done}/${todo.length}] FAILED ${url}: ${err.message}`);
    }
    if (done % 25 === 0 || done === todo.length) {
      fs.writeFileSync(INDEX, JSON.stringify(index, null, 1));
      rebuild();
    }
    if (done < todo.length) await sleep(DELAY_S * 1000);
  }
  fs.writeFileSync(INDEX, JSON.stringify(index, null, 1));
  if (!todo.length) rebuild();
  console.log(`Done: ${Object.keys(index).length} pages saved, ${failed} failed this run.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
