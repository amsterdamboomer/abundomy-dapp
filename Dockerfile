# Multi-stage build: builder bouwt dist-web/, runner draait relay + statische server.
# ---- builder ---------------------------------------------------------------
FROM node:24-alpine AS builder
WORKDIR /app

# Native deps voor blockstore-fs / sodium / etc.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci

COPY src/ ./src/
COPY web/ ./web/
COPY migration/ ./migration/
COPY vite.config.js ./

# Vite-build → ../dist-web/  (vite root is web/)
RUN npm run build:web

# ---- runner ----------------------------------------------------------------
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV ABUNDOMY_RELAY_ROOT=/data/relay
ENV ABUNDOMY_SQL=/app/1CoinH_24_05_2026.sql
ENV ABUNDOMY_RELAY_BIND=127.0.0.1
ENV PORT=8080

# tini = juiste signal-handling als PID 1
RUN apk add --no-cache tini

# Production node_modules opnieuw installeren (zonder devDeps zoals vite)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App-code + gebouwde SPA + SQL-dump
COPY --from=builder /app/dist-web/ ./dist-web/
COPY src/ ./src/
COPY web/ ./web/
COPY migration/ ./migration/
COPY 1CoinH_24_05_2026.sql /app/1CoinH_24_05_2026.sql

# Persistent volume mount-point (wordt door Fly volume bedekt)
RUN mkdir -p /data/relay && chown -R node:node /data /app
USER node

EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "web/server.mjs"]
