# ADR-0174: Agent Browser Runtime — Playwright sessions with approval-gated actions and receipts

- **Status:** Accepted (shipped in PR for #174)
- **Date:** 2026-06-12
- **Context issue:** [#174](https://github.com/gagan114662/agent-skills/issues/174)
- **Builds on:** [ADR-0025](0025-cloud-execution.md) (the `AgentRuntime`/`SessionManager` seam + the
  secret redactor), [ADR-0013](0013-approval-gates.md) (the human-approval gate; `browser.action` is a
  new sensitive-by-default action type), [ADR-0151](0151-ona-governance-trust.md) (the pure domain
  allow-list matcher, reused for the browser allow/denylist), [ADR-0147](0147-trial-caps.md)/[ADR-0040](0040-cloud-scale.md)
  (per-session caps), [ADR-0038](0038-cloud-posture-preflight.md) (the secret-free preflight/doctor +
  the launch gate), [ADR-0171](0171-self-qa-loop.md) (the lazy-Playwright driver pattern — and the
  trade-off this ADR closes), [ADR-0166](#) (the "never ship an image whose runtime can't spawn" lesson).

> **Numbering note.** Migration / ADR use the `0174` slot (the issue number), per the by-issue numbering
> convention (ADR-0099's note) — chosen to dodge sibling-workspace collisions in the shared sequence.

## Context

Agents can read the web (`WebFetch`/`WebSearch`) but cannot *drive* a real, rendered browser — log into
nothing, click nothing, see nothing. The directive: give every agent session its own first-class browser
(like the Codex app's built-in browser) that does real work, with receipts — and with safety gates that
make a mutating action impossible without a human. Three existing consumers are waiting: **scout** (SEO
audits want real rendered-page checks + CWV, not LLM-over-fetched-HTML), the **self-QA loop** (#171,
whose ADR-0171 flagged a Playwright driver as its one deferred trade-off), and **echo** (preview
rendering of queued social posts, behind approval).

## Decision

Add a `runtime/browser/` module: a Playwright-driven Chromium exposed to a session as seven tools
(navigate / read_page / screenshot / scroll / wait / click / type), with one isolated context per
session, side-effects gated through #13, receipts for every step, and per-session caps. Default OFF
(`RELOAD_AGENT_BROWSER_ENABLED`), owner workspace first.

### 1. The pure step gate is the testable safety contract (TDD)

`decideBrowserStep` (`runtime/browser/decide.ts`) is pure, total, and clock-free (the session supplies
`elapsedMs`): given a tool, the resolved caps, and the usage-so-far, it returns `allow` / `deny` /
`needs_approval` / `forbidden` / `disabled`. The decision order is most-restrictive-first: disabled →
forbidden (credentials/CAPTCHA, **never** overridable, not even by an approval) → denylisted domain
(reads AND writes) → caps (pages / wall-clock / bandwidth, `0 = unlimited`) → allowlist → approval. The
session never enforces policy itself beyond calling this gate, so the entire posture is unit-tested
without a browser. The tool surface (`tools.ts`) is the single source of truth for which tools mutate
remote state — a new tool can't silently bypass the gate.

### 2. Read-only is free; any mutation is a #13 approval

`navigate`/`read_page`/`screenshot`/`scroll`/`wait` are read-only and run for free. `click`/`type` are
side-effectful by default (a click submits/posts/purchases; typing fills a form) and ALWAYS pause for a
human. The session asks a `BrowserApprovalGate` seam; the safe default (`pendingApprovalGate`) refuses
and never touches the driver. Production (`storeBackedApprovalGate` + `dbBrowserApprovalStore`) wires the
real #13 system: a new `browser.action` type (sensitive-by-default in `DEFAULT_SENSITIVE_ACTIONS`, with
a recorded-only executor) lands on the same review queue with a full audit trail. The approval is keyed
to the exact action `(sessionId, tool, target)`, so one human decision unlocks exactly that one
mutation — the agent re-runs the step in-session and finds the approval (the re-check-at-execution model
of ADR-0013 §3), never a blanket "the browser can now do anything". Credentials and CAPTCHAs are
hard-`forbidden` regardless of approval.

### 3. One isolated context per session, tenant-scoped, torn down with the session

`BrowserSessionManager.open` allocates a fresh, profile-isolated `BrowserContext` (no shared cookies/
storage) per session, scoped by `workspaceId`, and frees it on `close`/`closeAll`. It is the enabled-flag
chokepoint (a workspace whose policy is OFF throws `BrowserDisabledError`) and refuses a second browser
per session. This mirrors how `SessionManager` allocates per-session resources and frees them in a
`finally`, into which the browser teardown wires.

### 4. Receipts — the "why?" surface

Every step (allowed, denied, or awaiting approval) writes a `browser_steps` row (migration 0174): URL,
action, decision, #13 approval id, screenshot path, bytes. Screenshots are deliverable attachments and
feed the console's live screenshot stream (the web Preview pane reuses the existing `run/RunPanel.tsx`
overlay machinery — coordinated with the redesign's peek-drawer PR). The recorder is a seam (in-memory
for tests, `dbBrowserReceiptRecorder` for prod). This is bookkeeping about what the browser did — it
holds no authority over any business table.

### 5. Caps reuse the established shape

`browser` is a new layered-config block (`enabled` + `maxPages`/`maxWallClockSeconds`/`maxBandwidthBytes`
+ `allowlist`/`denylist`), wired through all 7 schema sites + both `layers.ts` merge functions (the
silent-drop hazard) and the env base layer (`RELOAD_AGENT_BROWSER_*`). `resolveBrowserCaps` mirrors
`automations/caps.ts`; `0 = unlimited` throughout. The domain lists reuse the #151 matcher (`domainOf`/
`matchesAllowlist`); a denylist (checked first, for reads and writes) is the only new matcher.

### 6. The image must carry a working browser — preflight + smoke (the #166 lesson)

`preflight.ts` gains `browser-playwright` (FAIL when enabled but the package is missing) +
`browser-binary` (a Chromium presence WARN — Playwright manages its own binary). The authoritative
"can it actually spawn?" gate is the new post-deploy smoke (`scripts/agent-browser-smoke.ts`): it
launches the REAL Chromium, loads a live page through the session/manager path, asserts a receipt with a
screenshot, and proves the safety contract is live (an unapproved click refuses). It exits non-zero, so
it gates a deploy — we never ship an image whose browser can't spawn.

### 7. Image: debian-slim, not a sidecar

Playwright/Chromium need **glibc**; the runtime stage was Alpine (musl), which cannot run Chromium. We
moved the runtime stage to `node:22-bookworm-slim` rather than running the browser as a separate Fly
machine / microVM sidecar. The browser runs IN the server process (LocalRuntime), so a sidecar would add
an IPC/network boundary and a second machine for a default-OFF feature — debian-slim keeps a single
image, one process group. **Trade-offs:** (a) the base image grows (debian > alpine), and a browser
build adds a ~280 MB Chromium layer — so the Chromium install is behind a `--build-arg
INSTALL_AGENT_BROWSER=true` (default OFF), keeping the standard deploy lean until a deployment opts the
feature on; (b) debian ships `bash`, so the #166 `apk add bash` fix is no longer needed; (c) the
in-image `pnpm add playwright` mutates only the throwaway image layer's lockfile, keeping playwright OUT
of the repo's lockfile / CI install (consistent with ADR-0171).

### 8. Closing the ADR-0171 trade-off

ADR-0171 left `SELFQA_DRIVER=playwright` documented but un-wired (`resolveDriver` was sync, the driver
async). `resolveDriverAsync` now wires it, preferring a `createRenderedQaDriver` backed by THIS runtime
(a real rendered-page check with screenshot evidence — the "full click-through" self-QA deferred), with
the launch-only probe as a fallback. The CI default (http/none) is unchanged; no browser ever launches
implicitly.

## Consequences

- **Positive:** agents get a real browser that does real work, with receipts; mutations are impossible
  without a human and fully audited; tenant contexts are isolated; scout/self-QA/echo are unblocked; the
  safety posture is a property of a pure, fully-tested decider.
- **Negative / trade-offs:** the runtime image base changed (Alpine → debian-slim) — verified by the
  post-deploy smoke, not by the unit CI (which cannot build the image); a browser-enabled image is large;
  in-session execution-after-approval relies on the agent retrying the step (the executor is
  recorded-only, like `external.send`); per-step click-through for arbitrary self-QA steps (free-form
  English) is not auto-executed — the rendered-page check is.
- **Default-OFF:** unset `RELOAD_AGENT_BROWSER_ENABLED` ⇒ no session gets a browser, no preflight checks,
  the standard image is unchanged in behavior. The owner workspace opts in first.

## Alternatives considered

- **Chromium sidecar machine** (rejected for v1): cleaner image isolation, but an IPC/network boundary +
  a second Fly machine for a default-OFF feature; revisit if the browser needs to outlive a session or
  scale independently.
- **Expose the browser as an MCP server to the claude harness** (deferred): the harness has no tool
  registry — tools reach the agent as CLI flags/env. Wiring an MCP browser server through the spawn is a
  follow-up; this PR ships the runtime + the safety contract + the receipts as the foundation.
- **Run the side-effect at #13 approval time** (rejected): the live page lives in the agent's session
  process, not at approval time (minutes later, possibly another process) — so the executor is
  recorded-only and the session re-runs the step on approval, exactly as ADR-0013 §3 prescribes.
