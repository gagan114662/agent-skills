# syntax=docker/dockerfile:1
#
# Reload server image (#19). Multi-stage: build the workspace with pnpm, then ship a
# slim runtime that runs the compiled server as a non-root user. Migrations run on
# deploy via docker-entrypoint.sh (or as a dedicated one-shot service in compose).
#
# Build from the platform/ root:  docker build -f apps/server/Dockerfile -t reload-server .

# ---- build stage ----
# #174: build on debian-slim, NOT alpine. The runtime stage is debian (glibc) for Playwright, and native
# deps (e.g. @node-rs/argon2) compile against the builder's libc — building on Alpine/musl then running on
# debian/glibc would fail to load the prebuilt binary at boot. Matching both stages to glibc keeps the
# copied node_modules runnable. (debian-slim ships bash too, so the #166 spawn target is present here.)
FROM node:22-bookworm-slim AS build
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
# #174 BASE CHANGE Alpine → Debian (bookworm-slim). Playwright/Chromium need **glibc**; Alpine ships musl,
# which Chromium cannot run, so the official Playwright images don't support Alpine (ADR-0174). The agent
# browser runtime launches Chromium IN this server process (LocalRuntime), so the image itself must be
# glibc. debian-slim is the cleaner path than a separate Chromium sidecar machine for a single-image
# deploy (one process group, no IPC/network boundary; the trade-off — a larger base + an optional ~280MB
# Chromium layer — is documented in ADR-0174). Bonus: debian ships `bash`, so the #166 harness-spawn fix
# (`bash -lc "claude …"`) no longer needs a separate package install.
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
# Working HOME for the non-root runtime user (#166). Docker's `USER` directive does NOT set $HOME, and
# the `claude` CLI needs a writable home for its config/credentials dir. Pin it to the reload user's
# home so the harness child inherits a valid, writable HOME (verified: /home/reload, owned by reload).
ENV HOME=/home/reload
# #238: the per-session workspace root MUST be writable by the non-root `reload` user. The default
# (`.reload/workspaces`, resolved against the server's cwd = WORKDIR `/app`) lives under a ROOT-owned
# `/app` (`COPY --from=build` runs as root), so the #58 `FileConfigWorkspaceProvisioner.prepare()`
# `mkdirSync('/app/.reload/workspaces/<id>')` fails with EACCES BEFORE the harness ever spawns — the
# error is caught and surfaces as `exitCode=null` → the `spawn` failure class → the "missing a tool"
# copy, so EVERY real session died at provision (21 spawn failures, prod, #238). Point the root at the
# reload user's own home (created+chowned below) so provisioning succeeds. The startup preflight
# (#69) now probes this path's writability, and the post-deploy smoke provisions through it, so a
# non-writable root can never silently ship again.
ENV RELOAD_WORKSPACE_ROOT=/home/reload/agent-workspaces
WORKDIR /app

# #174: bake the agent browser (Playwright + Chromium) into the image only when a deployment opts in.
# DEFAULT OFF so the standard deploy stays lean (the feature is default-OFF, owner-workspace-first).
# A deployment that flips RELOAD_AGENT_BROWSER_ENABLED on MUST build with
# `--build-arg INSTALL_AGENT_BROWSER=true` — we never ship an image whose browser can't spawn (the #166
# lesson; the post-deploy `pnpm --filter @reload/server agent:browser-smoke` proves it end-to-end).
ARG INSTALL_AGENT_BROWSER=false
# A world-readable browser cache so Chromium (installed as root below) is runnable by the `reload` user.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Install the Claude Code CLI globally (PINNED, #166) so the `claude-code` harness can run a REAL agent
# under AGENT_RUNTIME=local (#68). Auth is per-tenant at runtime — the workspace's own subscription token
# (CLAUDE_CODE_OAUTH_TOKEN), resolved per session and injected as env — so NO credential is baked into
# the image. The binary is on PATH as `claude`, which the #69 preflight checks for. The reload user is
# created with debian's useradd (not busybox adduser).
#
# #238: also install `git` (PINNED). debian-bookworm-slim does NOT ship git, and the `claude-code`
# harness shells out to it (repo status/diff), as does the #51 GitWorkspaceProvisioner when a repo is
# configured — a missing `git` is exactly the "runtime is missing a tool" class the issue flags. The
# #69 preflight now asserts it for the real (claude-code/codex) harness so a git-less image fails the
# deploy, not the user. Pin to debian's stable build for a reproducible image (mirrors the claude-code
# pin); a debian point-release bump is a deliberate, visible lockfile change.
RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends git=1:2.39.5-0+deb12u3 \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @anthropic-ai/claude-code@2.1.173 \
  && groupadd --system reload \
  && useradd --system --gid reload --home-dir /home/reload --create-home reload \
  # #238: a writable per-session workspace root for the non-root user (see RELOAD_WORKSPACE_ROOT above).
  && mkdir -p /home/reload/agent-workspaces \
  && chown -R reload:reload /home/reload
# Same /app path as the build stage keeps pnpm's symlinked node_modules valid.
COPY --from=build /app /app
# Optionally install the `playwright` package + Chromium and its system libraries (#174). The `pnpm add`
# mutates only this throwaway image layer's lockfile (never the repo's), keeping playwright OUT of the
# default build graph / CI install (consistent with ADR-0171). Skipped entirely when the ARG is false.
RUN if [ "$INSTALL_AGENT_BROWSER" = "true" ]; then \
      mkdir -p "$PLAYWRIGHT_BROWSERS_PATH" \
      && pnpm --filter @reload/server add playwright \
      && pnpm --filter @reload/server exec playwright install --with-deps chromium \
      && chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"; \
    fi
USER reload
EXPOSE 3000

# Default: migrate-on-deploy, then start (single-container deploys). Compose overrides
# `command` to split these into an ordered one-shot `migrate` + long-running `server`.
CMD ["/app/apps/server/docker-entrypoint.sh"]
