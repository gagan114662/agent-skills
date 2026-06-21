# ADR-0420: sandcastle agent-runtime pilot — run ipop's agents inside mattpocock/sandcastle

- **Status:** Accepted (spike; shipped in PR for #420). Recommendation: **conditional go** — adopt sandcastle
  as the agent *sandbox/runner* behind one explicit gate (`AGENT_RUNTIME=sandcastle`), after the three parity
  risks below are closed on the Vercel provider. The live fleet is unchanged until then.
- **Date:** 2026-06-21
- **Directive:** "all ipop agents should run in this sandbox" — [mattpocock/sandcastle](https://github.com/mattpocock/sandcastle)
  (`@ai-hero/sandcastle`), "code like he says."
- **Builds on:** [ADR-0025](0025-agent-runtime.md) (the `AgentRuntime` seam: `local` vs `sandbox`),
  [ADR-0339](0339-eve-framework-pilot.md) (the isolated-pilot + text-parity-gate pattern this reuses),
  [ADR-0200](0200-premortem-panel.md) (#192 per-tenant credential discipline, #200 §4 reversibility),
  and the "managed fleet model, no user picker" rule.

## Context

Sandcastle is a TypeScript library that orchestrates a coding agent inside an isolated sandbox with a single
`run({ agent, sandbox, prompt })`. It supports Docker/Podman (bind-mount) locally and a **Vercel Firecracker
microVM** (`@vercel/sandbox`) for isolated/cloud runs; agents include Claude Code, Codex, Pi. It handles
session capture/resume, idle timeout, abort-to-cancel, branch strategy, and structured output.

ipop already has the `AgentRuntime` seam (ADR-0025): `LocalRuntime` (in-process child) and `SandboxRuntime`
(`@vercel/sandbox`). The SessionManager wraps the runtime with everything that must NOT change — admission
(#71), the #13 approval gate, the #319 disposition read, the channel stream, the idle/wall reapers, and
finalize. So "run all agents in sandcastle" reduces to: add a third `AgentRuntime` backend that delegates the
innermost step (HOW the harness runs and WHERE) to sandcastle.

## What was built

A **parallel pilot** at `platform/pilots/sandcastle-runtime/` — outside the pnpm workspace, not built by CI,
**not wired to prod** (mirrors the #339 eve pilot so a heavyweight external dep never touches the frozen
install):

- `runtime.ts` — `SandcastleRuntime implements AgentRuntime`. Idiomatic sandcastle (`run({ agent: claudeCode(
  "claude-opus-4-8", { env: { CLAUDE_CODE_OAUTH_TOKEN } }), sandbox: vercel()|docker(), prompt, signal,
  idleTimeoutSeconds, logging: { onAgentStreamEvent } })`) mapped onto ipop's `AgentJob`/`RunningSession`:
  task→prompt, per-tenant token→`claudeCode({ env })` (never in source), managed model (no picker),
  `cancel()`→`AbortController.abort()`, stream→`hooks.onOutput`, thrown run→`failed` (teardown parity),
  snapshot resume (#82)→`resumeSession`.
- `.sandcastle/` scaffold (Dockerfile mirroring the live image's git+ripgrep+claude toolchain, prompt
  template, `.env.example`), README, and the behavior-shape gate
  `apps/server/test/unit/sandcastle-runtime-pilot-parity.test.ts` (text-read; asserts idiomatic API usage,
  the interface mapping against the LIVE `runtime/types.ts`, the managed-model + #192 token discipline, the
  bypassPermissions rationale, and cancel/stream wiring).

## Decision

**Adopt the sandcastle *runtime* behind `AGENT_RUNTIME=sandcastle`, default-OFF, after closing three parity
risks on the Vercel provider.** Do NOT flip prod in this PR.

The live-wiring sequence (one focused follow-up PR each, gated, reversible):

1. **`RuntimeKind` += `"sandcastle"`** (`db/repositories/agent-sessions.ts` + `runtime/posture.ts`) and a
   `factory.ts` branch `if (env.runtime === "sandcastle") return new SandcastleRuntime(...)`. Lazy-import
   `@ai-hero/sandcastle` (like the Vercel adapter loads lazily), so the dep loads ONLY when selected.
2. **Close the three risks (below)** on the Vercel provider with a live smoke (mirrors the #69 post-deploy
   smoke): a real run reaches `running`, streams output to the channel, and finalizes.
3. **Flip `AGENT_RUNTIME=sandcastle` for the owner workspace first** (owner-workspace-first, like every other
   ipop rollout), watch the #487 diagnostic + the #394 reap rate, then widen.

## Risks (must close before enabling)

1. **Stream fidelity (highest).** ipop's `stream-json.ts` parses the raw `claude` stream-json (final answer,
   tool calls, the #319 disposition signal). Sandcastle exposes structured `onAgentStreamEvent`
   (`text|toolCall|raw`), not the raw stream — so the disposition read must key off `RunResult.stdout`/`output`,
   or the `raw` event must carry the underlying JSON. If neither holds, deliverable surfacing (#248/#319)
   regresses. Verify against a real run before enabling.
2. **Git ownership.** Sandcastle manages branches + commits; ipop has the #51 GitWorkspaceProvisioner and the
   #250 site-PR actuator (the real on-site publish path #364/#458). Decide: run sandcastle `branchStrategy:
   head` and let ipop's actuator own the PR (preferred — keeps the #13 gate as the only publish path), or
   adopt sandcastle's commits (re-opens the irreversibility question, #200 §4).
3. **Docker-on-Fly.** The prod server runs in a single Fly container; Docker-in-Docker is impractical, so prod
   MUST use the Vercel Firecracker provider (`@vercel/sandbox`, already a dep). Local/dev uses Docker. This is
   also the same in-memory-admission-counter constraint as #495 — sandcastle running each session in its own
   microVM does not by itself give HA; the counter still lives in the server process.

## Consequences

- **Reversible:** default-OFF, owner-first, one env var. `local`/`sandbox` are untouched; flipping back is
  instant. The pilot adds zero prod surface (isolated, CI-invisible) until step 1 ships.
- **Honest:** the parity gate proves the integration *shape* without a live run; the three risks are written
  down, not buried. Fully proving an end-to-end run needs the dep installed + a Docker/Vercel environment,
  which the live-smoke in step 2 provides.
- **#200:** the #13 human gate stays OUTSIDE the harness (`bypassPermissions` is why a non-interactive run
  doesn't deadlock, NOT a safety relaxation — ipop still gates every irreversible/money action). The tenant
  credential is injected per session from the #192 vault, never in source/snapshot/the sandbox layer.
