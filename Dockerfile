# WebSyncTERM — multi-stage build
#
# Stage 1 installs the workspace dependencies and builds the TypeScript
# packages and the front-end bundles.
# Stage 2 extracts the gateway's production dependencies into a
# self-contained directory.
# Stage 3 is the runtime image: the gateway, the static assets and nothing
# else.

FROM node:22-alpine AS build
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# Install the dependencies first so that the layer is cached.
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

# Extract the gateway's production dependencies.
FROM build AS deps
RUN pnpm --filter @websyncterm/gateway deploy --prod /out

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV GATEWAY_PORT=8023

COPY --from=deps /out/node_modules ./node_modules
COPY --from=deps /out/package.json ./package.json
COPY --from=build /app/apps/gateway/dist ./apps/gateway/dist

# The static assets served by the gateway.
COPY --from=build /app/apps/embed/dist ./apps/embed/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/render/assets ./packages/render/assets

USER node
EXPOSE 8023

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.GATEWAY_PORT||8023)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/gateway/dist/index.js"]
