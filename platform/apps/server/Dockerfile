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
# Working HOME for the non-root runtime user (#166). Docker's `USER` directive does NOT set $HOME, and
# the `claude` CLI needs a writable home for its config/credentials dir. Pin it to the reload user's
# home so the harness child inherits a valid, writable HOME (verified: /home/reload, owned by reload).
ENV HOME=/home/reload
WORKDIR /app
# #166 ROOT CAUSE FIX: the agent harness spawns `bash -lc "claude -p …"` (runtime/harness.ts), but this
# base image is Alpine, which ships only busybox `ash` as /bin/sh and has NO `bash`. So `spawn("bash")`
# failed with ENOENT before any agent ran — the child never returned an exit code, the session landed as
# `failed` with a null exit, and the channel showed "session failed (exit n/a)". Installing bash makes the
# harness command spawnable. bash is left unpinned (any Alpine 5.x is fine) so an apk patch-version
# rotation can't break the build that ships this fix; the agent-affecting pin is on the claude CLI below.
#
# Install the Claude Code CLI globally (PINNED, #166) so the `claude-code` harness can run a REAL agent
# under AGENT_RUNTIME=local (#68). Auth is per-tenant at runtime — the workspace's own subscription token
# (CLAUDE_CODE_OAUTH_TOKEN), resolved per session and injected as env — so NO credential is baked into
# the image. The binary is on PATH as `claude`, which the #69 preflight checks for.
RUN corepack enable \
  && apk add --no-cache bash \
  && npm install -g @anthropic-ai/claude-code@2.1.173 \
  && addgroup -S reload \
  && adduser -S reload -G reload
# Same /app path as the build stage keeps pnpm's symlinked node_modules valid.
COPY --from=build /app /app
USER reload
EXPOSE 3000

# Default: migrate-on-deploy, then start (single-container deploys). Compose overrides
# `command` to split these into an ordered one-shot `migrate` + long-running `server`.
CMD ["/app/apps/server/docker-entrypoint.sh"]
