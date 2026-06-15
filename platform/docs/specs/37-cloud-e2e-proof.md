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
Demo: the soak harness (`apps/server/scripts/cloud-e2e-soak.ts`, run via
`SOAK_N=5 pnpm --filter @reload/server soak`) is the current spend-free local proof; the live
cloud run requires credentials and is not run in CI. Recorded video
pending — Gagan approves on the video.

---

# Spec 37 (cont.) — Real agents in production via @mention (subscription-first)

> Added for the production cut of #68. The soak harness above proves the *runtime* under
> concurrency; this section closes the remaining product gap: **an owner @mentions a fleet agent on
> live ipop.ai and a REAL Claude session runs and replies in the channel** — billed to the owner's
> own Claude subscription, never a pooled platform key. Decision record: **ADR-0068**.

## Problem
The ipop fleet personas (scout, quill, echo, postmark, bid, lens, mark) are seeded in production
channels but only post static intros. On the Fly app (`reload-api`) `AGENT_HARNESS=demo`, so an
@mention launches the demo echo harness, not a real agent — nothing actually *works*. The end-to-end
@mention → #59 `SubagentService` → #71 admission → #25 session → post-back path already exists
(#123); what is missing is (a) a real harness on Fly with the `claude` binary, (b) **per-tenant
auth** that bills the owner's subscription, and (c) a graceful "connect your account" path when a
workspace has no auth yet.

## Decisions (full rationale in ADR-0068)

### Subscription-first auth, strictly per-tenant
1. Each workspace owner runs `claude setup-token` on their machine and pastes the resulting
   long-lived OAuth token into **Settings → Connect Claude**. It is stored as
   `CLAUDE_CODE_OAUTH_TOKEN` in a **per-tenant credentials vault** (`workspace_agent_credentials`),
   encrypted at rest when `AGENT_CREDENTIALS_ENC_KEY` is configured.
2. The cloud runtime resolves auth **per session, scoped to that session's workspace**, and injects
   the token as runtime env. The `claude` CLI reads `CLAUDE_CODE_OAUTH_TOKEN` natively, so the
   session bills the owner's subscription.
3. **Fallback order:** workspace subscription token → platform `ANTHROPIC_API_KEY` (only when the
   workspace has no token *and* the operator configured a platform key) → a friendly brand-voice
   "connect your Claude account" reply in the channel. Never crash.
4. **Hard compliance line — one subscription is never pooled across workspaces.** The vault is keyed
   by `workspace_id`; the pure `decideAgentAuth` only ever sees a single workspace's token; there is
   no code path that reads another tenant's token. The platform key is a single shared *operator*
   fallback (not a user subscription), used only when a tenant has connected nothing.

### Everything else is reuse (unchanged)
- **Metering / budget / 402:** #71 admission + `tenant_usage` — every launch increments
  `sessions_started`, teardown bills `compute_seconds`/`estimated_cost_cents`; a per-tenant budget
  cap yields `budget_exceeded` → 402. Verified by the headline integration test.
- **External sends stay approval-gated (#13):** personas carry draft-only tools; the in-channel
  reply to the owner is autonomous; anything leaving the building rides the #13 gate.
- **Kill switch (#17) + maintenance (#99):** admission honors the kill switch on every launch; the
  @mention route is a write, already covered by the maintenance write-gate.
- **Observability:** each session is one Braintrust span when `BRAINTRUST_API_KEY` is set (no-op
  otherwise).

## In scope
- `workspace_agent_credentials` vault (migration 0126) + repository, with at-rest encryption seam.
- Pure `decideAgentAuth` + `SubscriptionSecretsResolver` injecting the right secret per tenant.
- Mention-path auth gate: a friendly brand-voice connect prompt when a real harness has no auth —
  posted as the persona, **without** consuming an admission slot or budget.
- Settings API (`/me/agent-credentials`) + a **Connect Claude** web panel (masked input, never
  echoes the token, shows connected/not-connected).
- Fly image installs the `claude` CLI; `AGENT_HARNESS=claude-code` on the app.
- Headline integration test (fake harness): @mention → session → reply → `tenant_usage` metered;
  and the no-token → connect-prompt path.

## Out of scope
- Sandbox isolation under load (the soak section above; stays `AGENT_RUNTIME=local` on Fly for now).
- OAuth token *refresh* — `claude setup-token` tokens are long-lived; re-paste on expiry.

## Acceptance
- Unit: `decideAgentAuth` returns subscription→platform→none in order and never crosses tenants;
  `secretbox` round-trips and no-ops without a key.
- Integration: a fleet @mention on a `claude-code`-harnessed manager with a fake completing runtime
  posts the agent's reply in the channel and increments `tenant_usage` for that workspace; with no
  token connected and no platform key, the persona instead posts the connect prompt and **no**
  session row / usage row is created.
- The one owner step is documented in `docs/runbooks/fly-deploy.md`.
- typecheck/lint/build green; default (`demo`) posture and all existing tests unchanged.

## 🎥 PROVE (production cut)
Owner @mentions `@scout` in `#seo` on ipop.ai → scout runs a real `claude-sonnet-4-6` session and
replies in-thread. **Video gate waived by the owner for this issue.**
