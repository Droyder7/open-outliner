# Multi-stage Dockerfile for the Node server (API + Hocuspocus + background jobs).
# Production dependencies are installed separately from the build toolchain.

FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS base
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    corepack enable && NODE_USE_ENV_PROXY=1 corepack prepare pnpm@11.15.1 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/crdt/package.json packages/crdt/
COPY packages/server/package.json packages/server/
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    NODE_USE_ENV_PROXY=1 pnpm install --frozen-lockfile --prod=false

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/crdt/node_modules ./packages/crdt/node_modules
COPY --from=deps /app/packages/server/node_modules ./packages/server/node_modules
# Workspace manifests: pnpm --filter resolves packages by reading package.json
# files under the workspace root — without them the build RUN matches nothing.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/shared/tsconfig.json packages/shared/
COPY packages/shared/src packages/shared/src/
COPY packages/crdt/package.json packages/crdt/
COPY packages/crdt/tsconfig.json packages/crdt/
COPY packages/crdt/src packages/crdt/src/
COPY packages/server/package.json packages/server/
COPY packages/server/tsconfig.json packages/server/
COPY packages/server/src packages/server/src/
COPY tsconfig.base.json ./
COPY migrations ./migrations/
RUN pnpm --filter @open-outliner/shared build && \
    pnpm --filter @open-outliner/crdt build && \
    pnpm --filter @open-outliner/server build

FROM base AS production-deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/crdt/package.json packages/crdt/
COPY packages/server/package.json packages/server/
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    NODE_USE_ENV_PROXY=1 pnpm install --frozen-lockfile --prod

FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS runtime
WORKDIR /app

COPY --chown=node:node --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --chown=node:node --from=build /app/packages/shared/package.json packages/shared/
COPY --chown=node:node --from=build /app/packages/shared/dist packages/shared/dist/
COPY --chown=node:node --from=build /app/packages/crdt/package.json packages/crdt/
COPY --chown=node:node --from=build /app/packages/crdt/dist packages/crdt/dist/
COPY --chown=node:node --from=build /app/packages/server/package.json packages/server/
COPY --chown=node:node --from=build /app/packages/server/dist packages/server/dist/
COPY --chown=node:node --from=production-deps /app/packages/shared/node_modules packages/shared/node_modules/
COPY --chown=node:node --from=production-deps /app/packages/crdt/node_modules packages/crdt/node_modules/
COPY --chown=node:node --from=production-deps /app/packages/server/node_modules packages/server/node_modules/
COPY --chown=node:node --from=production-deps /app/node_modules node_modules/
COPY --chown=node:node --from=build /app/migrations migrations/

COPY --chown=node:node scripts/verify-restored.mjs scripts/verify-restored.mjs
USER node
EXPOSE 8787 8788
CMD ["node", "--env-file-if-exists=.env", "packages/server/dist/main.js"]
