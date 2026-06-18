# ADR-0338: Durable-workflow primitive — suspend / resume / retry-with-backoff / persist (foundational slice)

- **Status:** Accepted (slice 1 — the primitive + one ported consumer; broader fleet adoption is follow-up)
- **Date:** 2026-06-18
- **Context issue:** [#338](https://github.com/gagan114662/agent-skills/issues/338) — agents hand-stitch
  long waits and retries with bespoke loops; one literally froze on a blocking `until [ -s tmpfile ]` /
  `while (Date.now() < deadline) { …; await sleep }` poll. Modeled on Vercel Ship 26's Workflow SDK
  ("infinite compute durability": auto suspend / resume / retry / persist state).
- **Builds on:** [ADR-0172](0172-self-shipping-loop.md) (the persisted one-step-per-tick state machine this
  generalizes), [ADR-0105](0105-fleet-watchdog.md) (the pure `decide` + bounded-backoff split),
  [ADR-0035](0035-config-layering.md) (the layered, owner-first feature flag),
  [ADR-0013](0013-approval-gates.md)/[ADR-0243](0243-money-only-approval.md) (the #13 approval gate),
  [ADR-0155](0155-fleet-skills-semantic-layer-evals.md) (the colocation gate — non-governed table name),
  [ADR-0200](0200-premortem-panel.md) (the premortem this answers to).

## Context

A long-running agent step (wait for a deploy, poll a build, retry a flaky external call) had no durable
home. Each consumer hand-rolled the wait, and the dominant in-repo pattern is a synchronous blocking poll:

```ts
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  const res = await fetch(`${api}/repos/${owner}/${repo}/pages`, { headers });
  if (built(res)) return url;
  await sleep(3000); // holds the request/executor path for up to 120s, survives no restart
}
```

(`GitHubPagesPublishProvider.waitForBuild` — the worst offender: a real, #13-gated publish path that
hogs the event loop for two minutes and loses all progress on a restart.) This is exactly the failure the
issue names. The fleet has no shared way to **suspend** a step, **persist** where it got to, **resume** it
on the next tick (or after a restart), and **retry with bounded backoff** — without inventing a parallel
scheduler (the codebase already has ~15 supervisor ticks and the build-loop durable state machine).

### Premortem (#200) obligations

- **§2/§3 production-grounded + idempotent:** a resumed run must read its state back from the persisted
  row and must never double-apply a finished step. "It probably succeeded" is not allowed.
- **§4 reversibility:** an irreversible step must not run autonomously — it goes through the #13 gate.

## Decision

Add a self-contained `durable-workflow/` module — a **persisted run-ledger + a pure decision core + a thin
engine that does the IO** — and reuse it, do not rebuild a scheduler.

1. **Pure core.** `decide.ts#decideStep` (mirrors `decideRevival`) returns ONE action from the persisted
   state + the injected clock: `done | timeout | exhausted | gate | wait | run`, in that priority. `backoff.ts#nextBackoffMs`
   is deterministic exponential-capped backoff (no clock, no jitter → unit-pure). Both fully unit-tested.

2. **Persisted ledger.** `durable_runs` (migration `0338`, numbered by issue to dodge sibling-branch
   collisions, modeled on `build_loop_runs`):
   `status` machine + `attempts` + `next_attempt_at` (the backoff cursor) + `deadline_at` (the no-hang
   wall-clock bound) + `state`/`result` jsonb + `unique(workspace_id, idempotency_key)`. That unique
   constraint makes "one run per logical job" a database invariant — the structural guarantee behind
   "a resumed start RESUMES, never forks" (idempotency, §2). The table name is intentionally NOT
   `venture_`/`growth_`/`moat_`/`demand_`-prefixed so the #155 colocation gate does not class it as a
   governed metric surface. `approval_request_id` is the load-bearing column for the gate (§4).

3. **Engine.** `runner.ts#DurableRunner` with an injected `DurableRunStore` (Postgres-backed
   `dbDurableRunStore`; `InMemoryDurableRunStore` for tests + the no-DB fallback) and an injected
   clock/sleep (deterministic tests). `advance(record)` applies exactly ONE step and persists — what a
   supervisor tick calls per `store.listDue` run, so a suspended run resumes across ticks AND restarts.
   `runToCompletion(opts)` is the foreground driver that replaces the blocking poll: it suspends out each
   backoff window but is bounded TWO ways — the per-step `maxAttempts` cap AND an absolute iteration
   backstop that force-fails the run `no_progress` — so it can **never hang**, even if an injected clock
   misbehaves (the whole point).

4. **Flag.** `durableWorkflow` config block (the standard owner-first checklist: schema + layers + loader
   env `RELOAD_DURABLE_WORKFLOW_*` + `caps.ts`), **default OFF**, owner-workspace-first. A deployment that
   sets nothing keeps the legacy in-process poll byte-for-byte.

5. **Gate (§4).** A step flagged `requiresApproval` cannot RUN without an `approvalRequestId`; the runner
   parks it `waiting_approval` (no side effect) — the structural #13 always-gate. This is NOT added to
   `MONEY_ACTIONS` (it is a per-step structural gate, like `hosted.publish`/`outreach.send`).

6. **Ported consumer (the proof).** `GitHubPagesPublishProvider.waitForBuild` now delegates, behind the
   flag, to a durable `PublishBuildWait` (the poll suspends/backs-off/persists). Flag-OFF or no injected
   wait ⇒ the original loop runs unchanged. The `factory.ts` + `delivery/default.ts` construction sites
   inject the production durable wait lazily (DB store + base-layer caps), so the default dry-run path is
   untouched.

## Consequences / Follow-ups

- **Reuse, not a new scheduler:** `advance` is designed to be driven by an existing supervisor tick over
  `store.listDue`; wiring it into a tick for true background cross-restart resume (vs. the foreground
  `runToCompletion`) is the obvious next slice. This ADR ships the primitive + the foreground driver + one
  consumer; it does not yet add a new engine timer.
- **Multi-step DAGs:** this slice models a single suspendable step (the issue's consumer is a single poll).
  Generalizing to a multi-step workflow (a sequence/graph of steps with per-step idempotency keys) is a
  deliberate follow-up — the `state` jsonb + `step` cursor leave room for it.
- **Other consumers to port:** `deploy/vercel-provider.waitForReady` (a 240s blocking poll) is the next
  best candidate; the seam is identical.
- **No infra change:** build + PR only. The migration is written + reversible (`0338` up/down) but not run
  here; the durable path is OFF by default so production behavior is unchanged until an owner enables it.
