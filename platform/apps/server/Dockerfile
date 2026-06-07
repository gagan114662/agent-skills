# syntax=docker/dockerfile:1
#
# Reload server image (#19). Multi-stage: build the workspace with pnpm, then ship a
# slim runtime that runs the compiled server as a non-root user. Migrations run on
# deploy via docker-entrypoint.sh (or as a dedicated one-shot service in compose).
#
# Build from the platform/ root:  docker build -f apps/server/Dockerfile -t reload-server .

# ---- build stage ----
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable

# Manifests first so `pnpm install` is cached until a dependency actually changes.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

# Source, then build only what the server needs (shared types + server).
COPY . .
RUN pnpm --filter @reload/shared build && pnpm --filter @reload/server build

# ---- runtime stage ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable \
  && addgroup -S reload \
  && adduser -S reload -G reload
# Same /app path as the build stage keeps pnpm's symlinked node_modules valid.
COPY --from=build /app /app
USER reload
EXPOSE 3000

# Default: migrate-on-deploy, then start (single-container deploys). Compose overrides
# `command` to split these into an ordered one-shot `migrate` + long-running `server`.
CMD ["/app/apps/server/docker-entrypoint.sh"]
