# Prestige voice + text chat widget

A chat button for shop.ttkprestige.com. Clicking it opens a chat window where visitors can type or talk. Answers come from Claude, using product information scraped from the store.

```
scraper/scrape.js   crawls the store sitemaps, saves each page's HTML to data/raw/
scraper/clean.js    turns the saved pages into a clean, structured data/catalog.json
server/search.js    search over the catalogue (understands mixie, kadai, chulha, Hindi, "under 5000")
server/server.js    /api/chat: finds the relevant products, asks Claude, streams the reply
public/widget.js    the embeddable chat bubble (text, mic input, spoken replies)
public/index.html   demo page
```

## Setup

```bash
npm install
cp .env.example .env      # then put your Anthropic API key in .env
```

## 1. Scrape the store

```bash
npm run scrape
```

The store's robots.txt asks crawlers to wait 10 seconds between requests, so a full crawl of about 1,715 pages takes around 5 hours. The crawl saves as it goes and resumes where it stopped, so you can stop it and run it again. Since this is your own site, you can lower the delay with `--delay 2` (about 1 hour) if your web team is fine with it.

- `npm run scrape -- --limit 20` scrapes 20 pages for a quick test.
- Run `npm run scrape -- --fresh` every week or so to pick up new products and price changes. The server reloads the catalogue on its own, so there's no need to restart it.
- If the site sends "too many requests" or "blocked" responses, the scraper waits a minute or more before trying again instead of hammering the site.

### Data cleaning

`npm run scrape` runs the cleaner automatically every 25 pages. To re-run it on its own, for example after changing `scraper/clean.js`, run `npm run clean`. It doesn't touch the website. For each product it keeps:

- name, category, price, MRP and discount, and whether it's in stock;
- every size, colour or burner option with its own price, stock and specs (for example 2.5 L / 3 L / 5 L);
- key features, description, a tidy spec table, warranty and care tips.

It removes menus, empty review boxes, the factory and customer-care addresses repeated on every page, duplicate pages, and spec rows that just repeat the title. It also fixes spacing and spelling slips like "Alumunium".

## 2. Run the chat server

```bash
npm start
```

Open http://localhost:3030 and click the red button in the bottom-right corner.

Without `ANTHROPIC_API_KEY` (local testing only), replies come from the Claude Code CLI installed on this Mac (`claude`, signed in with your Claude account), so you can try real answers before you have a key. Set `CLAUDE_CLI_MODEL` (default `sonnet`; `opus` for the larger model). The live website needs `ANTHROPIC_API_KEY`.

## 3. Put it on the website

Deploy this folder to any Node 22 host (Render, Railway, an EC2 box, etc.) with `ANTHROPIC_API_KEY` and `ALLOWED_ORIGINS=https://shop.ttkprestige.com` set. Then add this line to the Magento theme before `</body>`:

```html
<script src="https://YOUR-SERVER/widget.js" data-server="https://YOUR-SERVER" defer></script>
```

Optional attributes: `data-title`, `data-color` (default `#c8102e`), `data-lang` (speech language, default `en-IN`; use `hi-IN` for Hindi), `data-greeting`, `data-voice` (part of a browser voice name to prefer; default `Google हिन्दी`, Chrome's Hindi voice, and browsers without it get their most natural voice; try them all at `/voices.html`).

## Shopping inside the widget

On shop.ttkprestige.com the customer never has to leave the chat:

- **Product view**: product cards and links open full details inside the chat (photo, sizes with prices, features, specs, warranty).
- **Add to cart**: pick a size and quantity; the item goes into the customer's real store cart (the store's header cart updates too).
- **Cart**: change quantities or remove items from the cart icon in the chat header.
- **Checkout**: opens the store's own secure checkout page inside the widget (address, delivery, payment). When the order is placed, the chat says so and the conversation carries on.
- The conversation is saved for 7 days in the browser, shared by all tabs, with a "Welcome back!" bubble when a customer returns.

Cart and checkout only work when the widget runs on the store itself (same site, same cart). On other pages, like the local demo, the product view shows a "Buy on website" link instead.

## How voice works

- **Mic button:** starts a hands-free conversation. It listens, sends what you said, reads the answer aloud, then listens again. Tap it again to stop.
- **Knowing when you've finished:** a pause alone doesn't end your turn. About 0.65 s into a pause, the widget quietly sends what you've said so far with `turnCheck: true`. The planner reads it with the chat and decides `done`: "I want a cooker for my" or "mujhe cooker chahiye lekin" isn't finished; "5 litre" answering a question is. Finished: the server sends `\u0006` and streams the answer, which the widget uses at once, so the reply starts sooner too (about 3.2–3.6 s after you stop). Not finished: the server sends `\u0015` and the widget waits up to 4.5 s more. If you speak again before the verdict, that request is dropped and a new one starts. If the server can't judge, a pause of your learned length ends the turn.
- **Learning each customer:** if you carry on after it has started answering, it takes back the half question and answers the whole sentence. It also waits longer for you next time (stored in the browser: `prestige-check-ms`, `prestige-pause-ms`).
- **Talking over it:** while it thinks or speaks, just talk (or say "wait", "ruko") and it stops and listens.
- **Speaker button (header):** also reads typed answers aloud.
- **Google voice everywhere (recommended):** Chrome and Edge already have a human-sounding voice for free. Set `GOOGLE_TTS_API_KEY` in `.env` and Safari, iPhone and Firefox get the same Google Hindi voice (`hi-IN-Wavenet-A`) from Google Cloud Text-to-Speech, at about $4 per million characters. The server calls Google, so the key never reaches the browser, and repeated sentences are cached so each is paid for once.
- **ElevenLabs (optional, costly at high traffic):** save the key on `/admin.html` and every browser uses it. Pick the voice and model there too (add more voices from the [ElevenLabs voice library](https://elevenlabs.io/app/voice-library), then press Test again). Open pages pick up the new voice when reloaded. Each sentence's audio is requested as soon as Claude writes it, so speech starts before the full answer is finished.
- **Fallback:** without a voice key, or if a request fails, the widget uses the browser's built-in voice for free.
- Voice input (the mic) works in Chrome, Edge and Safari. Firefox gets text chat only.

## Quality test

`npm run quality` (with the server running) asks the assistant 51 real customer questions, 12 of them open-ended and 6 sales situations ("too expensive", "I'll think about it", "Hawkins is cheaper", "just browsing", "I'll take it") ("induction cooker that saves electricity", "first kitchen under 10000") from `test/questions.json`: sizes, induction, budgets, Hindi and Hinglish, follow-ups, returns, complaints, voice and more. It checks every answer against the catalogue:
- product answers recommend a product and end with a next step (a question or "add it to your cart")
- links are real store pages
- every ₹ price belongs to the product it's quoted for
- out-of-stock products are named as out of stock
- no "all / most models" claims, and no store-wide claims ("we've got four", "range from ₹A to ₹B") made from the few products the assistant was shown
- only the real customer-care numbers
- no stock bot phrases, and replies stay short

The answers go to `data/quality/` so a person can read them. Run it after any change to the prompt, search or catalogue.

## Speed

First words arrive in about 2–3 s; a full answer takes 4–8 s. What matters:
- **No thinking.** Sonnet 5.5 and Haiku 5.5 think before answering unless told not to, which delayed some replies by up to 49 s and, in a test, made no answer more accurate. The API call sends `thinking: between_tools` (Sonnet) or `disabled` (Haiku); Demo mode turns it off in the Claude app's settings.
- **Medium effort** for the answer (low effort skipped searches it needed), low effort for the planning step.
- **Demo mode keeps a Claude app started and waiting** for each job, so a reply doesn't wait for the app to start, and the reply ends as soon as the text is done rather than when the app exits.

## Ready answers (instant replies)

First questions that customers ask again and again ("best offers?", "5 litre cooker") are answered at once from stored answers (`server/cache.js`):
- **Never out of date:** each stored answer keeps a fingerprint of the store search results it was written from: products, prices, MRP, discounts and stock. Every request runs the searches again on the current catalogue (a couple of milliseconds). If anything changed, such as a new price, a new offer or a product going out of stock, a fresh answer is written and stored in its place. Answers older than a day are dropped too.
- **Only safe questions:** the first message of a chat (follow-ups depend on the chat so far), only when Sonnet is answering, and only answers that used no extra search. Messages that are long or look personal (emails, phone or order numbers) are never stored.
- **Search plans** are stored for any chat seen before, so a repeated question skips the planning step. Plans hold searches, not prices.
- **ElevenLabs audio** is stored per voice and model; sentences heard twice are kept on disk (`data/cache/tts`) and cost no credits again.
- **Nightly warm-up:** `npm run warm` asks the questions in `server/starters.json`, plus those customers asked more than once, in text and voice. `deploy/refresh.sh` runs it after each price refresh, so tomorrow's answers use tonight's prices. Unchanged ones come back from the store and cost nothing.
- The pilot report shows how many replies were ready answers. The warm-up's own chats aren't counted as visitors, but their cost is.
- The catalogue is only as fresh as the last scrape (nightly). A price changed on the website at noon reaches stored and fresh answers alike after the next refresh.

## WhatsApp number check

Stops one person from running up the bill with an endless chat (`server/verify.js`).

| Question | Answer |
|---|---|
| When does it ask? | After `FREE_QUESTIONS` (default 5) questions a day per browser, or 40 a day from one network address. |
| What then? | The widget shows a number form. The shopper gets a 6-digit code on WhatsApp, and the question waiting is answered once they confirm. |
| After confirming? | `VERIFIED_DAILY` (default 50) questions a day per number for 30 days, then the customer-care number. |
| What's stored? | A keyed hash of the number, never the number. Codes are hashed, last 5 minutes and allow 5 tries. |
| Abuse limits | A 30 s wait between codes, 3 an hour per number, 6 an hour per address, `WHATSAPP_DAILY_CAP` (default 1,000) a day. |
| Cost | About ₹0.115 + GST per code delivered in India (Meta authentication rate; check Meta's INR rate card). |
| Turn on | /admin.html → WhatsApp number check: access token, phone number ID, the approved Authentication template (copy-code button) and its language. Off until saved. |
| Test locally | `WHATSAPP_DEV=on` prints codes to the server console instead of sending them. |

The nightly warm-up and `npm run quality`, run on the server itself, are not counted.

## Pilot report and spending guard

The widget counts, with a random id per browser and no personal data:
- visitors who saw the chat button
- visitors who opened it
- visitors who chatted

The server logs every reply's model, tokens and cost to `data/usage/`. `/report.html` turns that into the real chat share, replies per chat, cost per chat and a monthly forecast, next to the figures the cost plan assumed. It needs the `REPORT_TOKEN` password when opened from anywhere but the server.

**Spending guard:**
- When Sonnet has used `SONNET_BUDGET_USD` (default $500) in a month, Haiku answers everything until the 1st, so the chat keeps working.
- `MONTHLY_BUDGET_USD` (default $600) is the hard limit. When it's reached, the assistant pauses and gives the customer-care number. Set the same amount as the spend limit in the Anthropic console.

**Settings page:** `/admin.html` switches between **Demo** (answers through the Claude app on this computer, free) and **Live** (through the API key). It also takes the Anthropic, Google and ElevenLabs keys and tests them. For ElevenLabs it lists your voices (Indian-accent ones first), shows the credits left, picks the speech model and plays a sample. It also sets both budgets. Changes apply without a restart and are saved to `.env`. Keys are never shown again, only their last 4 characters. The page opens only on this computer, or anywhere with the `REPORT_TOKEN` password.

Going live (server, HTTPS, nightly price refresh, the line for the Magento theme) is in [deploy/DEPLOY.md](deploy/DEPLOY.md).

## How answers are generated

The assistant is written as a **salesperson**, not an information desk:
- It leads with a pick and upsells when the step up is worth it.
- It cross-sells one add-on: the planner searches for it, for example a gasket with a cooker or a kadai with a stove.
- It handles "too expensive" and "I'll think about it".
- It uses only real discounts and stock as urgency. The offer it quotes is the product's own discount (sale price vs MRP); it never invents coupons or bank offers.
- When the exact thing isn't there (another brand, a size or model the store lacks, out of stock, something Prestige doesn't sell), it says so briefly and recommends the closest product instead of offering to "check".
- It answers the latest message. After 15 minutes away the earlier chat stays on screen under a "New conversation" divider, but it isn't sent to the assistant, so an old topic can't steer a new question.
- Searches relax the way a salesperson would (server/tools.js): nothing under the budget, so show the cheapest; no such size, so show the sizes there are and that size in other models; no stock, so show it as out of stock. A NOTE tells the assistant what was relaxed. A named kind of product ("pressure cooker", "knife") only returns that kind, cooker spare parts appear only when asked for, and "750 watt", "750-watt" and "750W" match the same products.
- A short rules reminder goes next to each question (`REMINDER` in server.js), since long chats drift from rules at the top of the prompt.
- It closes with "tap the card and add it to your cart".

Every link is checked while the reply streams. A link Claude wrote from memory is pointed at the real product page, or removed, and each case is logged.

Every answer takes two steps, so Claude answers from real store data and not from memory:
1. **Plan** (`server/planner.js`, Haiku, about a second): read the chat and decide which store searches to run, the way a showroom person thinks. For example, "rice and dal for one" becomes a 2–3 L pressure cooker, "induction cooker that saves electricity" becomes energy-saving induction cooktops sorted by lowest power, and "which one is cheapest?" keeps the size and stove from earlier in the chat. The searches always run.
2. **Answer** (Sonnet): writes the reply from those results. It can search again with the store tools (`server/tools.js`), filtering by category, material, size, induction, price range, or sorting by price or wattage. It can also open a product's full page or the store's policy pages. Anything it wrote before a search is cleared from the widget.

Demo mode gives the Claude app the same tools through a small MCP server (`server/mcp.js`). The system prompt in `server/server.js` sets the tone and the rules: never invent prices or specs, no claims about a whole range, no offers to "check later". Set `DEBUG=1` to print each plan and search in the server log.

**Models:** Sonnet writes every answer, since every answer is a sales conversation. Haiku (`claude-haiku-5-5`, about 1/20 of Sonnet's price) plans the searches, and takes over the answers when the month's Sonnet budget runs out. `ROUTING=on` in `.env` sends greetings and simple price or stock questions to Haiku again (rules in `server/router.js`). That is cheaper, but in testing Haiku over-generalised ("most Svachh cookers work on induction", when 43 don't).
