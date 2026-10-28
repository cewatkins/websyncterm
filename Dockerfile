# WebSyncTERM — multi-stage build
#
# Stage 1 builds the TypeScript packages and the front-end bundles.
# Stage 2 produces a small runtime image containing only the gateway, the
# static assets and the production dependencies.

FROM node:22-alpine AS build
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/render/package.json packages/render/
COPY packages/audio/package.json packages/audio/
COPY packages/xfer/package.json packages/xfer/
COPY packages/rip/package.json packages/rip/
COPY apps/web/package.json apps/web/
COPY apps/embed/package.json apps/embed/
COPY apps/gateway/package.json apps/gateway/
RUN pnpm install --frozen-lockfile || pnpm install

COPY . .
RUN pnpm build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV GATEWAY_PORT=8023

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/gateway/package.json apps/gateway/
RUN pnpm install --frozen-lockfile --prod --filter @websyncterm/gateway || \
    pnpm install --prod --filter @websyncterm/gateway

COPY --from=build /app/apps/gateway/dist apps/gateway/dist
COPY --from=build /app/apps/embed/dist apps/embed/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=build /app/packages/render/assets packages/render/assets

USER node
EXPOSE 8023

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.GATEWAY_PORT||8023)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/gateway/dist/index.js"]
