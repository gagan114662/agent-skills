# ADR-0388: Browser session-injection — inject a per-workspace logged-in session into the fleet browser

- **Status:** Accepted (slice 1 — the session-injection seam + vault key + config flag — shipped in PR for #388)
- **Date:** 2026-06-19
- **Context issue:** [#388](https://github.com/gagan114662/agent-skills/issues/388) — computer-use outreach.
  The fleet should reach real people by **driving real web apps like a human** (X, webmail) through the
  #174 agent browser, instead of an API/OAuth outbound path. The #174 runtime is a real, drivable Chromium
  (navigate/click/type/screenshot/read-DOM, every side-effect #13-gated) — but it is **authless**:
  `browser.newContext()` is hardcoded with no `storageState`, by design ("ONE fresh, profile-isolated
  context per session — no shared cookies"). To operate a site the owner is logged into, the browser must
  be able to load a **logged-in session**. That seam did not exist. This is the unblocker.
- **Builds on:** [ADR-0174](0174-agent-browser-runtime.md) (the Playwright driver / session / manager /
  decide / caps / approval / receipts stack — reused, not rebuilt; the #13 gate and the hard-forbidden
  `credentialEntry` stay intact), [ADR-0192](0192-external-credentials-vault.md) (the per-tenant sealed
  vault — the session blob is stored here, read back only via `resolveServiceSecrets`),
  [ADR-0386](0386-attributed-revenue-ledger.md) (the default-OFF, owner-workspace-first config pattern,
  copied verbatim), [ADR-0200](0200-premortem-panel.md) (standing rails — owner-first, no money path,
  the irreversible SUBMIT stays gated).

## Context

To post to X / send Gmail via the browser with **no API and no OAuth**, the agent must operate inside an
account the owner is already logged into. The agent itself is barred from logging in:
`type(..., {credentialEntry:true})` is hard-forbidden (ADR-0174 §2) and CAPTCHA-solving is hard-forbidden —
so login state can only arrive as **injected session state** captured once by a human. Playwright models
this exactly: `browser.newContext({ storageState })` seeds a context with cookies + per-origin
`localStorage`. That blob grants live account access, so it is a **secret**: it must never live in config,
env, logs, or receipts.

## Decision

Add a **default-OFF, owner-workspace-first** session-injection seam. When (and only when) the flag is active
for a workspace and a target site is supplied, the manager resolves the per-workspace logged-in
`storageState` from the vault and opens the context **with** it; otherwise every context is authless —
**byte-for-byte today's behavior**.

**Slice 1 (this PR):**

- `runtime/browser/session-store.ts` (pure) — `BrowserStorageState` (a structural slice of Playwright's
  `storageState`, declared locally so the pure module never imports playwright); `parseStorageState(raw)`
  — a **total, fail-closed** parse + shape-validate (safe JSON, `cookies[]` + `origins[]` required,
  malformed entries dropped) that returns `null` on anything malformed and never throws; the
  `BrowserSessionResolver` seam; the vault-key helpers (`browser_session:<target>`, field `STORAGE_STATE`).
- `db/repositories/browser-session-store.ts` — the DB-backed resolver: reads the sealed blob from the #192
  vault via `resolveServiceSecrets(workspaceId, "browser_session:<target>")` and `parseStorageState`s it.
  Absent / revoked / malformed ⇒ `null` (authless fallback). **No new table or migration** — it reuses the
  existing per-workspace `external_credentials` vault, one row per workspace+target.
- `runtime/browser/driver.ts` — `newContext` takes an OPTIONAL `storageState`; with it,
  `browser.newContext({ storageState })` (logged-in); without it, `browser.newContext()` exactly as before.
  The fake driver records the injected state so tests can assert pass-through.
- `runtime/browser/manager.ts` — `open({ ..., target? })` resolves the `storageState` only when the
  injection flag is active for the workspace AND a resolver + target are wired; a resolver that throws or
  finds nothing fails closed to an authless context.
- `runtime/browser/session-injection-caps.ts` + the `sessionInjection` config block (5+2+1, mirroring
  `attribution`): schema (`enabled?`, `ownerWorkspaceId?`) + root + `ResolvedConfig` + `CONFIG_DEFAULTS` +
  type; layers replace-merge + default; loader `RELOAD_BROWSER_SESSION_INJECTION_ENABLED` /
  `_OWNER_WORKSPACE_ID`. Fail-closed: unset owner ⇒ nobody.

## Safety (unchanged hard rules)

- The injected session is a **secret** — it lives sealed in the #192 vault, never in config/env, and never
  enters a receipt or log. The session only records `tool/url/detail`, never page content or the injected
  state, so the blob cannot leak by construction; the #25 redactor's per-session secret set already covers
  every vault value resolved for the workspace.
- `type(..., {credentialEntry:true})` stays **hard-forbidden**; **no** login/credential-typing path is
  added — login comes only from injected state captured once by a human.
- The **SUBMIT/post** click stays **#13-gated** (decide.ts unchanged) — this slice supplies a session, it
  does not weaken the gate on the irreversible outbound action.

## Honest blockers

1. **Prod browser availability** — the fly image only bakes Chromium when built with
   `--build-arg INSTALL_AGENT_BROWSER=true`; the default deploy has NO browser. Prod must (a) build the
   heavy image, (b) flip `RELOAD_AGENT_BROWSER_ENABLED`, AND (c) flip
   `RELOAD_BROWSER_SESSION_INJECTION_ENABLED` for the owner workspace. Verify the running image before
   claiming a live post.
2. **Bot detection** — X and Gmail aggressively fingerprint headless Chromium; a vanilla
   `chromium.launch({headless:true})` will likely hit login walls / "unusual activity" / CAPTCHAs (which
   decide.ts hard-forbids solving). Realistic posting needs stealth (headful, real UA, residential egress)
   — out of scope here.
3. **Session freshness** — a human must capture the `storageState` once (log into X/Gmail) and keep it
   fresh; sessions expire and 2FA re-prompts. Refresh is a manual, owner-gated step. No capture UI exists.
4. **Tenant isolation** — the stored session is scoped per workspace+target (`browser_session:<target>`)
   and read back only by `resolveServiceSecrets` (never pooled), so an injected session never bleeds across
   tenants.

## Slice 2 — the agent→browser tool bridge (this PR)

**Mechanism chosen.** The real, existing transport for exposing a server-side capability to a fleet agent
is the **Reload MCP server** (`mcp/server.ts`, `createReloadMcpServer(identity, deps)`): thin tool adapters
over server logic, each scoped to `identity.workspaceId`. (The harness only passes Claude Code's *built-in*
tool **names** via `--allowedTools` — it cannot reach an in-process server object — so MCP is the only seam
that can hand an agent a server-driven browser. We do NOT invent a new transport.)

`runtime/browser/agent-bridge.ts` (`createBrowserAgentBridge`) builds the seven browser tools as
MCP-shaped `BrowserBridgeTool[]`, each routing through `BrowserSessionManager` → `BrowserSession.step()`:

- **Gated, default-OFF, owner-first.** The whole bridge is gated on the workspace `[browser]` `enabled`
  flag (via the resolved `BrowserCaps`). Disabled ⇒ `{ tools: [] }` ⇒ the bridge is not offered, so a
  flag-off deployment is **byte-for-byte today's behavior**. Owner-first injection is inherited from
  slice 1 (the manager only injects `storageState` when the session-injection flag is active for the ws).
- **Session injection.** The session is opened with the `target`, so the slice-1 manager loads the
  per-workspace logged-in `storageState` (when its flag is active) — else authless. The session is opened
  LAZILY on the first tool call and reused (one browser per session, the manager's invariant).
- **No bypass.** The bridge adds no policy of its own: every call (read OR side-effect) funnels through the
  single `step()` path that enforces caps + domain lists + the side-effect classification, asks the #13
  approval gate for `click`/`type`, hard-forbids `credentialEntry`, and records a receipt + screenshot.
- **SUBMIT stays #13-gated.** There is NO autonomous post path. An unapproved side-effectful tool call
  (the SUBMIT click / a form `type`) returns `ok:false` with the pending approval id — the driver is never
  touched — exactly the smoke-test posture. A later slice may add an owner-overridable autonomous mode.

**Honest seam boundary.** The bridge is wired as a pure factory + unit-tested end-to-end against a real
`BrowserSession` (over the fake driver), but it is **not yet registered into the live `createReloadMcpServer`**.
What remains to make a live agent drive the browser: (a) register the `BrowserBridgeTool[]` as MCP tools in
`mcp/server.ts` (map each to a `mcp.registerTool` adapter, zod input schema per tool), constructing the
bridge from the request's `identity.workspaceId` + the agent's session id + a per-agent `target`; (b) own
the session lifecycle across the MCP connection (open lazily, `manager.close` on disconnect); (c) the
standing prod blockers from slice 1 (build the browser image, flip `RELOAD_AGENT_BROWSER_ENABLED` +
`RELOAD_BROWSER_SESSION_INJECTION_ENABLED`, capture a fresh `storageState`, stealth for bot-detection).

## Follow-ups

- Register the bridge tools into the live MCP server (slice 3) — the wiring described above.
- Per-target playbooks (the X-post / Gmail-compose selector flows) and a session-capture flow.
