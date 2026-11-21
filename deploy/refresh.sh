#!/bin/sh
# Nightly price and stock refresh: re-fetches every page at the store's own
# 10-second crawl delay (about 5 hours, so run it at night), then rebuilds the
# catalogue. The running server picks up the new catalogue by itself. Then it
# rewrites the ready answers to common questions whose prices or stock changed.
set -e
cd "$(dirname "$0")/.."
node scraper/scrape.js --fresh --delay 10 >> data/scrape.log 2>&1
node scraper/clean.js >> data/scrape.log 2>&1
sleep 10 # the server re-reads the catalogue every 5 seconds
node server/warm.js >> data/scrape.log 2>&1
