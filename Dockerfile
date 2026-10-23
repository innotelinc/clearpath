# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    DB_PATH=/data/clearpath.db
WORKDIR /app
RUN useradd --system --uid 10001 --create-home clearpath \
 && mkdir -p /data && chown -R clearpath:clearpath /data
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY views ./views
COPY public ./public
COPY scripts ./scripts
USER clearpath
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
