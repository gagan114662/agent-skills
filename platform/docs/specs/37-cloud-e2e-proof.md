# Spec 37 — Cloud e2e / soak proof (#68)

## Goal
Prove the agent-execution loop works end-to-end and under concurrency — not just that it compiles.
After the gap sprint (#25 cloud runtime, #50 real harness, #51–#59) the core promise — *a real
coding agent runs in a Vercel Sandbox, edits code, streams back, and is reaped* — had been
exercised only once, against an empty sandbox. This closes that gap.

## Deliverable
A standalone soak harness (`scripts/cloud-e2e-soak.ts`, `pnpm --filter @reload/server soak`) that
drives **N concurrent** sessions through the same `AgentRuntime` the server uses (`createRuntime` +
the configured harness) and reports per-session status, **spin-up latency**, time-to-first-output,
sandbox/snapshot ids, and that every session reached a terminal (reaped) state.

It runs in two modes from one code path:
- `AGENT_RUNTIME=local` (default): real host child processes, **no cloud spend** — proves
  concurrency, isolation, live streaming, and teardown for free (CI/dev-safe).
- `AGENT_RUNTIME=sandbox` + `AGENT_HARNESS=claude-code` + `VERCEL_*`: the **billable live proof** —
  a real coding agent in a per-session Vercel Sandbox.

## In scope
- Concurrent launch of N sessions; aggregate report (completed/total, spin-up p50/max, wall time).
- Local-mode run as repeatable, spend-free evidence.
- Reaping proof: `wait()` resolving for every session means teardown (snapshot + stop) ran.

## Out of scope (follow-ups / other issues)
- Idle/wall-clock reaper assertions under load — covered by SessionManager unit tests; deepen later.
- Warm pools, autoscaling, multi-region, cost caps → **#71**.
- Productized enable + preflight → **#69**.

## Acceptance
- `SOAK_N=5 pnpm --filter @reload/server soak` (local) completes 5/5 and reports metrics. Captured
  as the local evidence in the PR.
- The sandbox+claude-code path is documented and runnable by a human with credentials (the live,
  billable proof — not run in CI).
- typecheck/lint/build green; no default behavior changed (soak is opt-in).
- ADR-0037 records the approach and what the live run must show.

## 🎥 PROVE
Demo video: the soak running N real sessions (local) + one real cloud session, at
`platform/docs/demos/37-cloud-e2e-proof.mp4`. Gagan approves on the video.
