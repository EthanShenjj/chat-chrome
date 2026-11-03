FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends zip ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json .npmrc ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 AE_CHAT_SERVER_DATA_DIR=/data AE_CHAT_NPM_CLI=/usr/local/lib/node_modules/npm/bin/npm-cli.js
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* && mkdir /data && chown node:node /data
COPY --from=builder --chown=node:node /app/apps/server/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/server/.next/static ./apps/server/.next/static
COPY --from=builder --chown=node:node /app/apps/server/public ./apps/server/public
COPY --from=builder --chown=node:node /app/scripts/server-user.mjs ./scripts/server-user.mjs
USER node
EXPOSE 3000
VOLUME /data
CMD ["node", "apps/server/server.js"]
