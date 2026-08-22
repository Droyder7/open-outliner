# Multi-stage Dockerfile for the Node server (API + Hocuspocus + background jobs).
# Builds a lean production image with no devDependencies.

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@11.15.1 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/crdt/package.json packages/crdt/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile --prod=false

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

FROM node:22-alpine AS runtime
RUN corepack enable && corepack prepare pnpm@11.15.1 --activate
WORKDIR /app

COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist/
COPY --from=build /app/packages/crdt/package.json packages/crdt/
COPY --from=build /app/packages/crdt/dist packages/crdt/dist/
COPY --from=build /app/packages/server/package.json packages/server/
COPY --from=build /app/packages/server/dist packages/server/dist/
COPY --from=build /app/packages/shared/node_modules packages/shared/node_modules/
COPY --from=build /app/packages/crdt/node_modules packages/crdt/node_modules/
COPY --from=build /app/packages/server/node_modules packages/server/node_modules/
COPY --from=build /app/node_modules node_modules/
COPY --from=build /app/migrations migrations/

EXPOSE 8787 8788
CMD ["node", "--env-file-if-exists=.env", "packages/server/dist/main.js"]
