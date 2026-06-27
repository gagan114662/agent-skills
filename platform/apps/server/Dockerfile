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
# #292: stamp the git SHA of the build into the running image. `GET /version` returns this, which lets the
# deploy pipeline externally verify the running release actually ADVANCED — a no-op deploy leaves the OLD
# sha live, and `/readyz` (deps only) cannot detect that (the "stuck on v80 while CI is green" blocker).
# CI passes `--build-arg GIT_SHA=${{ github.sha }}`; defaults to "" for local/dev builds (treated as
# "unknown", never a confirmed match). ARG is per-stage, so it must be (re)declared in the runtime stage.
ARG GIT_SHA=""
ENV GIT_SHA=$GIT_SHA
WORKDIR /app

# #174: bake the agent browser (Playwright + Chromium) into the image only when a deployment opts in.
# DEFAULT OFF so the standard deploy stays lean (the feature is default-OFF, owner-workspace-first).
# A deployment that flips RELOAD_AGENT_BROWSER_ENABLED on MUST build with
# `--build-arg INSTALL_AGENT_BROWSER=true` — we never ship an image whose browser can't spawn (the #166
# lesson; the post-deploy `pnpm --filter @reload/server agent:browser-smoke` proves it end-to-end).
ARG INSTALL_AGENT_BROWSER=false
# A world-readable browser cache so Chromium (installed as root below) is runnable by the `reload` user.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Install the agent CLIs globally (PINNED, #166/#1270) so the real harnesses can run under
# AGENT_RUNTIME=local (#68). Auth is injected at runtime — Claude per-workspace via
# CLAUDE_CODE_OAUTH_TOKEN, Codex via CODEX_AUTH_JSON — so NO credential is baked into the image. The
# binaries are on PATH as `claude` and `codex`, which the #69 preflight checks for. The reload user is
# created with debian's useradd (not busybox adduser).
#
# #238: also install `git` (PINNED). debian-bookworm-slim does NOT ship git, and the `claude-code`
# harness shells out to it (repo status/diff), as does the #51 GitWorkspaceProvisioner when a repo is
# configured — a missing `git` is exactly the "runtime is missing a tool" class the issue flags. The
# #69 preflight now asserts it for the real (claude-code/codex) harness so a git-less image fails the
# deploy, not the user. Pin to debian's stable build for a reproducible image (mirrors the claude-code
# pin); a debian point-release bump is a deliberate, visible lockfile change.
# #488: also install `ripgrep` — Claude Code's Grep/search shells out to `rg` (it ships a vendored
# fallback, so the harness can run without it, which is why the image spawned even while `rg` was absent;
# but the system binary is the path it prefers and the tool most associated with the "runtime is missing a
# tool" class). Left UNPINNED (unlike git): `rg` is a behavior-stable search CLI, and bookworm only carries
# one version, so a point-release bump is not a reproducibility concern worth a hard pin that could break the
# build. The #69 preflight does NOT gate on it (the harness runs without it), so this can never block a deploy.
RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git=1:2.39.5-0+deb12u3 ripgrep \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @anthropic-ai/claude-code@2.1.173 @openai/codex@0.142.2 \
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
