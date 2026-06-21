# Sandcastle agent-runtime pilot (#420)

A spike that ports ipop's agent runtime onto [mattpocock/sandcastle](https://github.com/mattpocock/sandcastle)
(`@ai-hero/sandcastle`), toward the goal: **all ipop agents run inside the sandcastle sandbox.**

This is a **parallel pilot** — outside the pnpm workspace, not built by CI, **not wired to production**. The
live fleet is untouched until the go/no-go in [`ADR-0420`](../../docs/adrs/0420-sandcastle-agent-runtime.md).
The behavior-shape gate is `apps/server/test/unit/sandcastle-runtime-pilot-parity.test.ts`, which reads this
code as text (no `@ai-hero/sandcastle` import, so CI needs none of the pilot's deps).

## What sandcastle gives us

One call runs a coding agent in an isolated sandbox and manages the branch:

```ts
import { run, claudeCode } from "@ai-hero/sandcastle";
import { vercel } from "@ai-hero/sandcastle/sandboxes/vercel";

const result = await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: vercel(),       // Firecracker microVM in prod; docker() locally
  prompt: "…the task…",
});
```

- **Isolation:** Docker/Podman locally, **Vercel Firecracker microVM** in prod (`@vercel/sandbox`, which ipop
  already depends on).
- **Lifecycle:** session capture/resume, idle timeout, structured output, abort-to-cancel.

## How it maps onto ipop

`runtime.ts` implements ipop's existing `AgentRuntime` seam (the same interface `LocalRuntime`/`SandboxRuntime`
satisfy), so it drops in behind `AGENT_RUNTIME=sandcastle` with the SessionManager, admission (#71), the #13
gate, and disposition (#319) all unchanged:

| ipop seam | sandcastle |
|-----------|-----------|
| `AgentJob.env.AGENT_TASK` | `run({ prompt })` |
| `job.secrets.CLAUDE_CODE_OAUTH_TOKEN` (per-tenant, #192 vault) | `claudeCode(model, { env })` — never in source |
| managed model (no user picker) | `claudeCode("claude-opus-4-8")` |
| `hooks.onOutput` (channel stream) | `logging.onAgentStreamEvent` |
| `RunningSession.cancel()` (reaper + #469 Stop) | `AbortController` → `signal` |
| `RunningSession.wait()` → terminal result | `run()` promise → `RuntimeResult` (throw ⇒ `failed`) |
| snapshot resume (#82) | `resumeSession` / `result.iterations[0].sessionId` |

## Run the standalone pilot locally

```bash
cd platform/pilots/sandcastle-runtime
npm install
npx @ai-hero/sandcastle init            # scaffolds .sandcastle/ (kept here, checked in)
npx @ai-hero/sandcastle docker build-image   # builds sandcastle:local from .sandcastle/Dockerfile
cp .sandcastle/.env.example .sandcastle/.env # paste a CLAUDE_CODE_OAUTH_TOKEN
npm run typecheck
```

## Open questions (tracked in ADR-0420)

1. **Stream fidelity** — ipop's `stream-json.ts` parses the raw `claude` stream-json (final answer, tool
   calls, the #319 disposition signal). Sandcastle exposes structured `onAgentStreamEvent` (`text|toolCall|raw`),
   not the raw stream — so the disposition read must key off `RunResult.stdout`/`output`, or `raw` must carry
   the underlying JSON. **This is the highest-risk parity item.**
2. **Git ownership** — sandcastle manages branches + commits; ipop has the #51 GitWorkspaceProvisioner + the
   #250 site-PR actuator. We run sandcastle with `branchStrategy: head` and let ipop's actuator own the PR, or
   we adopt sandcastle's commits. Must be decided before enabling.
3. **Completion model** — sandcastle ends on a completion signal / idle timeout; ipop ends on process exit. The
   `.sandcastle/prompt.md` emits `<promise>COMPLETE</promise>`; the harness prompt needs that instruction.
4. **Docker-on-Fly** — the prod server runs in a Fly container; Docker-in-Docker is impractical, so prod uses
   the **Vercel** provider. Local/dev uses Docker.
