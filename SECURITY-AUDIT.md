# Security audit: shop.ttkprestige.com and the chat widget

Date: 13 Nov 2026. Method: one passive request to the store homepage (response headers only, no scanning), plus a read of this project's server, widget and deploy files.

## Part 1: the live store (what one response showed)

Is traffic forced onto HTTPS? Yes. HSTS is set for one year, but without includeSubDomains or preload. Add both once every subdomain serves HTTPS.

Is there a Content-Security-Policy? Only a form-action rule. There is no script-src, so the CSP does nothing against injected scripts (the main risk for a Magento store: card-skimming scripts). Build a real CSP starting in report-only mode.

Clickjacking? Protected. X-Frame-Options is SAMEORIGIN.

MIME sniffing, referrer, camera/mic? All set correctly (nosniff, strict-origin-when-cross-origin, permissions-policy denies geolocation, microphone, camera).

Is anything leaking? Two headers give away internals: x-platform-server shows the AWS instance id, and x-debug-info is a base64 debug blob. Strip both at the CDN (Fastly). x-xss-protection is obsolete and can go.

Is the HTML cached? No. Cache-Control is no-store on the page, which is right for a logged-in store.

What was not checked? TLS cipher details, cookie flags on login, admin paths, third-party scripts, Magento version and patches. Those need the hosting team or an authorised scan.

## Part 2: this chat server (what to fix before go-live)

Can someone guess the admin password? Yes, slowly. /api/settings and /api/report check the REPORT_TOKEN but have no rate limit and use a plain string compare. Add rateLimited() to both and compare with crypto.timingSafeEqual.

Can the node port be reached directly? server.listen(PORT) binds every interface. If port 3030 is open on the box, callers bypass nginx and can set X-Forwarded-For to dodge the rate limits. Bind to 127.0.0.1 or firewall the port.

Does the admin page travel in clear text? Only if nginx is left on port 80. DEPLOY.md says to run certbot; do it before the first password is typed, since the API keys are posted through that page.

Does the private-network CORS header matter? Access-Control-Allow-Private-Network is sent to everyone. It is only for local testing; drop it in production.

Can memory run out? The rate-limit map never evicts old IPs. Low risk, but prune keys older than a minute on each call.

Can the request body be abused? No. Bodies are capped at 100 KB, history at 12 turns of 2,000 characters.

Is the widget open to XSS? No. Replies are escaped before the markdown pass, links only accept http(s), and user text is always escaped.

Can /api/product fetch arbitrary URLs? No. It looks the URL up in the local catalogue only.

Are secrets safe on disk? Yes. .env is gitignored and written with mode 600; the admin page only receives the last four characters of each key.

Does the scraper behave? Yes. It honours the store's 10-second crawl delay and robots.txt.

## Priority order

1. Bind the server to 127.0.0.1 and put nginx on HTTPS.
2. Rate-limit and timing-safe the admin password check.
3. Ask the hosting team to strip x-platform-server and x-debug-info and add a real CSP on the store.
4. Remove the private-network CORS header for production.
