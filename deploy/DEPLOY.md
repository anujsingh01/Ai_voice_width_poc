# Going live

About an hour for someone who has set up a Linux server before. Everything the assistant needs runs on one small server in Mumbai.

## 1. Accounts and keys

| What | Where | Note |
|---|---|---|
| Anthropic API key | console.anthropic.com → API keys | Under **Limits**, set a monthly spend limit of **$600**. That is the hard cap; the bill can't go past it. |
| Google Cloud TTS key | console.cloud.google.com → enable "Cloud Text-to-Speech API" → Credentials → API key | Restrict the key to that one API. Only used for iPhone and Safari. |
| Server | AWS Lightsail, Mumbai (ap-south-1), Ubuntu, 2 GB plan (about $20 a month) | Open ports 80 and 443. |
| Web address | DNS: `chat.ttkprestige.com` → the server's IP | Any name works. |

## 2. Install on the server

```bash
sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install -y nodejs
sudo useradd -m prestige
sudo mkdir -p /opt/prestige-chat && sudo chown prestige /opt/prestige-chat
```

Copy this project folder to `/opt/prestige-chat` (without `node_modules`), then:

```bash
cd /opt/prestige-chat
sudo -u prestige npm ci --omit=dev
sudo -u prestige cp .env.example .env
sudo -u prestige nano .env
```

In `.env`, set `REPORT_TOKEN` (a long password) and `ALLOWED_ORIGINS=https://shop.ttkprestige.com`. Everything else (keys, Live mode, budgets) can be set later on `https://chat.ttkprestige.com/admin.html` with that password.

## 3. Start it and add HTTPS

```bash
sudo cp deploy/prestige-chat.service /etc/systemd/system/
sudo systemctl enable --now prestige-chat
sudo cp deploy/nginx.conf /etc/nginx/sites-available/prestige-chat
sudo ln -s /etc/nginx/sites-available/prestige-chat /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d chat.ttkprestige.com
```

Check that `https://chat.ttkprestige.com/api/health` shows `"ok":true` and about 1,725 pages.

## 4. Nightly price refresh

Prices and stock change, so the catalogue is re-read every night at the store's 10-second crawl delay. That takes about 5 hours, from 1 am to 6 am India time. Server time is UTC, so add this line with `sudo -u prestige crontab -e`:

```
30 19 * * * /opt/prestige-chat/deploy/refresh.sh
```

## 5. Put it on the shop

Ask the Magento team to add this one line before `</body>` in the theme. In the Magento admin, that's Content → Design → Configuration → HTML Head → Scripts and Style Sheets.

```html
<script src="https://chat.ttkprestige.com/widget.js" data-server="https://chat.ttkprestige.com" defer></script>
```

## 6. During the pilot

Open `https://chat.ttkprestige.com/report.html` and enter the `REPORT_TOKEN` password. It shows:
- visitors, chat opens and chats per day
- the real chat share, next to the 2% the plan assumed
- cost per chat and the Haiku share
- a monthly forecast built from our own numbers

The server stops spending money on its own. Once Sonnet has used $500 in a month, Haiku answers until the 1st. At $600 in total, the chat pauses and gives the customer-care number. Both amounts can be changed on the settings page.
