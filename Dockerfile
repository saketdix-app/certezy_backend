# ── Stage 1: install production dependencies ──────────────────
FROM node:24-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# ── Stage 2: runtime ──────────────────────────────────────────
FROM node:24-alpine AS production
WORKDIR /app
ENV NODE_ENV=production

# Run as non-root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --from=deps --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --chown=appuser:appgroup . .

USER appuser
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:5000/health || exit 1

CMD ["node", "server.js"]
