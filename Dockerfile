# Chat server for the Prestige widget (Node 22, no database). Live mode only: needs ANTHROPIC_API_KEY.
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-slim
ENV NODE_ENV=production PORT=3030 HOST=0.0.0.0
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
COPY scraper ./scraper
COPY data ./data
# data/ is a volume in docker-compose.prod.yml (usage, cache, verify); the first start copies the catalogue into it.
# .env is bind-mounted so the /admin.html settings page can save keys.
RUN mkdir -p data/usage data/verify data/cache/tts && chown -R node:node /app/data \
 && touch /app/.env && chown node:node /app/.env
USER node
EXPOSE 3030
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3030/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--env-file-if-exists=.env", "server/server.js"]
