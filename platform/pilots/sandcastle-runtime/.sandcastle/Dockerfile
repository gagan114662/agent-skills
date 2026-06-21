# Sandcastle local sandbox image (#420). Mirrors the tools the live agent image ships (apps/server/Dockerfile)
# so an agent run inside sandcastle has the same toolchain as the bespoke runtime: git + ripgrep (#488) + the
# Claude Code CLI. `npx @ai-hero/sandcastle docker build-image` builds this into `sandcastle:local`.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @anthropic-ai/claude-code@2.1.173

WORKDIR /workspace
