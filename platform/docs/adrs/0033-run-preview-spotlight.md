# ADR-0033: Run tab — run a session's app, in-app preview, click-to-annotate round trip

- **Status:** Accepted (Gagan approves defaults-and-go on the demo video — issue #56)
- **Date:** 2026-06-09
- **Context issue:** [#56](https://github.com/gagan114662/agent-skills/issues/56) (Feature phase 4 —
  Real execution & Conductor parity)
- **Builds on:** [ADR-0025](0025-cloud-execution.md) (AgentRuntime / `LocalRuntime` spawn seam /
  `SessionManager` / `AgentJob.cwd`), [ADR-0028](0028-git-pr-review.md) (worktree-per-session cwd +
  the review→agent **round trip**), [ADR-0035](0035-config-layering.md) (layered config — where the
  run command is declared)

## Context
The platform can launch agents (#25) and review their diffs (#28), but a developer still cannot *see
the thing run*. Conductor's loop is **run → look → point at what's wrong → the agent fixes it**: a Run
tab that runs the app and detects its localhost port, an in-app browser **preview**, and **Agentation**
annotations you attach to the agent as context. We had none of it.

This ADR adopts that loop for the parts that fit one atomic PR — run-script execution + port detection,
an in-app iframe preview, and click-to-annotate feeding the agent — and explicitly defers Spotlight
(single-instance branch hot-swap) and the cloud/same-origin preview proxy.

## Decisions

1. **A separate `RunProcessManager`, NOT the `SessionManager`.** `SessionManager`'s contract is *run a
   harness to completion and finalize the session row* — single-shot, teardown-on-exit. A dev server
   is **long-lived** and must never finalize the session. Routing it through `SessionManager` would put
   a long-running, user-triggered process inside the most safety-critical, most-tested orchestrator. So
   `run/manager.ts` is a standalone manager that reuses only the proven spawn **primitive** from
   `LocalRuntime` (detached process group, piped stdio, `killTree`), keyed by `sessionId`, one run per
   session, idempotent start. This is the same blast-radius discipline #28 used by keeping `commitTurn`
   off the launch path.

2. **Run state is in-memory and ephemeral — no DB table.** A run process is a child of the server and
   dies with it; there is nothing meaningful to persist across a restart. The live record is the
   `run_status`/`run_log` realtime events plus the `GET …/run` snapshot. This keeps the PR atomic (no
   migration) and matches the nature of the thing being modeled.

3. **The run command comes from trusted layered config (#35), never the request.** A `run` section
   (`{ command, port?, readyPattern? }`) is added to the config schema; it is repo/managed scope. The
   `POST …/run` body carries **no** command, so a channel member cannot turn the endpoint into
   arbitrary RCE beyond what the deployment already chose to make runnable — the same trust boundary as
   the #27 harness command (`AGENT_TASK` is data via env; the command is fixed by config). Starting a
   run still requires **channel write capability**; every route resolves the session **scoped to its
   channel** (`getAgentSession(id, cid)`), so it is IDOR-safe.

4. **Port detection is a pure, ReDoS-safe function over output lines.** `run/detect.ts` scans each
   line for a bound localhost address with **bounded** patterns (`\d{1,5}`, capped `.{0,40}`, no nested
   quantifiers) covering the common dev servers (`http://localhost:PORT`, `Local: …`, `listening on
   port N`, `127.0.0.1:PORT`), validates the port is in TCP range, and normalizes the host to
   `localhost` (browser-reachable). An explicit configured `port` short-circuits detection. stdout and
   stderr are line-buffered **independently** so their partial lines can't interleave and corrupt the
   ready banner.

5. **Annotations feed the agent via the #28 round trip — no new agent IPC, no persistence.** A running
   agent is single-shot; there is no server-side mid-run steering channel. So delivering annotations
   mirrors the proven review→agent path: `POST …/annotations` formats the collected notes into a task
   string ("The user annotated the running preview at <url>: …") and calls
   `sessionManager.launch({ task })` as a **follow-up session** in the same channel. This reuses the
   entire launch path (RBAC, IDOR, worktree, channel streaming). Annotations are collected client-side
   and delivered as one batch — conceptually a review comment on the running UI rather than a diff line.
   The payload is **bounded** (≤50 notes, capped lengths) because it is interpolated into the agent's
   prompt.

6. **The preview is a direct iframe to `localhost:PORT`; the annotation overlay is coordinate-based.**
   The localhost app is a different origin, so we never read the iframe's DOM — the overlay is our own
   absolutely-positioned layer and annotations are **normalized (0–1) viewport fractions** plus the
   user's note, stable across pixel sizes. An "Annotate" toggle flips the overlay's `pointer-events` so
   the user can either drive the app or drop pins. Realtime `run_status`/`run_log` ride the existing
   channel bus (no gateway change, exactly like #28 PR events); the web store gets a `RunState` slice
   mirroring the review slice.

## Alternatives considered

- **Run the dev server through `SessionManager`.** Rejected — it would finalize the session on exit and
  load a long-lived, user-triggered process onto the safety-critical orchestrator (Decision 1).
- **A same-origin reverse proxy / tunnel for the preview.** Deferred. It makes the preview cloud-reachable
  and immune to a framing-blocking `X-Frame-Options`, but a robust proxy must rewrite asset URLs and
  bridge HMR websockets — a large, brittle surface that would break PR atomicity. v1 iframes localhost
  directly (the LocalRuntime default: server and browser share a host); the `url` seam already carries
  whatever a future proxy points at.
- **Persist annotations / run state in the DB.** Rejected for v1 — the value is the round trip, and a
  child process's state is inherently ephemeral. Adds a migration for no durable benefit.
- **Accept the run command in the request body.** Rejected — it is arbitrary RCE for any channel writer
  (Decision 3).

## Consequences
- A developer can run a session's app, preview it live in-app, point at the UI, and have the agent act
  on those points — the Conductor loop, on our stack.
- **Limitations (documented):** the preview only works for the **local** runtime (a remote sandbox port
  isn't browser-reachable) and for dev servers that don't set a framing-blocking header; the same-origin
  proxy/tunnel and **Spotlight** branch hot-swap are filed as follow-ups.
- New surface: `run/{manager,detect,default}.ts`, `routes/run.ts`, `run_status`/`run_log` events +
  `publishRunEvent`, a `run` config section, and the web Run tab (`RunPanel`, `run` store slice,
  `api.run`). Covered by unit tests (detection + annotation formatting + config merge), an integration
  test (real spawn binds a port → detection → events → annotation round trip → stop → 409/400/IDOR), and
  web component tests. `pnpm -C platform typecheck && lint && test && build` green.
