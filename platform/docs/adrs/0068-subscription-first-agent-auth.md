# ADR-0068: Subscription-first agent auth — real fleet agents billed to the owner's own Claude

- **Status:** Accepted (Gagan approves defaults-and-go; **video gate waived by the owner** — issue #68)
- **Date:** 2026-06-11
- **Context issue:** [#68](https://github.com/gagan114662/agent-skills/issues/68) (prove the cloud
  agent path end-to-end — real agents working in production via @mention on live ipop.ai)
- **Builds on:** [ADR-0025](0025-cloud-execution.md) (the `SecretsResolver` seam — secrets resolved
  per tenant at provision, injected as runtime env, redacted from output), [ADR-0027](0027-real-agent-harness.md)
  (the `claude-code` harness; task/model/auth flow as env, never argv), [ADR-0036](0036-subagents.md)
  (the `SubagentService` gate the @mention path reuses), [ADR-0040](0040-cloud-scale.md)
  (`tenant_usage` metering + the admission chokepoint: kill switch, budget→402, concurrency),
  [ADR-0013](0013-approval-gates.md) (external sends gated), [ADR-0043](0043-disaster-recovery.md)
  (Redis maintenance flag), the #123 marketing fleet (`MarketingMentionService`).
- **Numbering:** ADR-**0068** (number-by-issue) — ADR-0037 already records the soak-harness cut of
  this issue; this records the distinct *subscription-first auth* decision so the two don't collide.

## ⚠️ Decision first — reuse the existing @mention path; add only per-tenant auth
The end-to-end path an owner needs — `@scout` in `#seo` → audited #59 gate → #71 admission → #25
session → result posted back in-thread — **already exists** (#123). The only reason nothing runs in
production is the live posture: `AGENT_HARNESS=demo` and no model credentials. So #68 is **not** a new
agent path. It is three things:

1. A **real harness on Fly** (install `claude`, flip `AGENT_HARNESS=claude-code`).
2. **Per-tenant auth** so a session bills the *owner's* Claude subscription, not a platform key.
3. A **graceful no-auth path** so a workspace that hasn't connected yet gets a friendly reply, never
   a crash or a silent dead @mention.

Re-implementing the launch/metering/approval machinery would duplicate the most safety-critical code
in the system. We touch only the **secrets layer** and add a **settings surface**.

## Decisions

### 1. Subscription-first, strictly per-tenant (`runtime/agent-auth.ts`)
`decideAgentAuth({ subscriptionToken, platformKey })` is a pure, total function returning one of:
- `{ mode: "subscription", secrets: { CLAUDE_CODE_OAUTH_TOKEN } }` — the workspace's own token;
- `{ mode: "platform", secrets: { ANTHROPIC_API_KEY } }` — only when the workspace has **no** token
  and the operator configured a platform key;
- `{ mode: "none", secrets: {} }` — neither; the caller posts the connect prompt.

Order is subscription → platform → none. The function only ever receives a **single** workspace's
token, so it is structurally incapable of crossing tenants — the compliance invariant lives in the
type, not a runtime check.

### 2. One subscription is never pooled — the hard compliance line
The vault (`workspace_agent_credentials`) is keyed by `workspace_id` (primary key). `resolve(workspaceId)`
reads that workspace's row and nothing else. There is no "shared subscription" code path and no cache
across tenants. The **platform `ANTHROPIC_API_KEY`** is the *operator's* key (a single org account a
self-hoster may provide), not a user's subscription — using it as a last-resort fallback for tenants
who connected nothing is not pooling a subscription. A user's `CLAUDE_CODE_OAUTH_TOKEN` is used only
for that user's workspace, ever.

### 3. The vault encrypts at rest behind a seam (`crypto/secretbox.ts`)
`seal`/`open` are AES-256-GCM with a key from `AGENT_CREDENTIALS_ENC_KEY` (32 bytes, base64/hex).
**No key → transparent passthrough** (ciphertext == plaintext) so dev/CI need no key, while a real
deployment sets one and the token is encrypted on disk. We persist a non-reversible `tokenFingerprint`
(`sha256(token)` prefix) for the UI's "connected" state — the token itself is **never** read back out
to any API response, only injected into a runtime as env (where the SessionManager redactor already
scrubs it from all output/logs).

### 4. `SubscriptionSecretsResolver` replaces the env-only resolver, additively
It composes the vault read (per `workspaceId`) + the platform fallback + the existing
`EnvSecretsResolver` (so `AGENT_SECRETS`/`AGENT_SECRET_KEYS` and other secrets still flow). The
resolved auth secret takes precedence. Wired into the production `SessionManager`; the default
`demo`/local posture resolves to `mode:"none"` with no DB row and is unchanged.

### 5. No-auth on a real harness → a friendly connect prompt, off the spend path
The auth gate lives in `MarketingMentionService` (the user-facing @mention orchestrator), **before**
the launcher. When the deployment harness *requires* auth (`claude-code`/`codex`) and the workspace
resolves to `mode:"none"`, the persona posts a brand-voice "ask the owner to connect Claude in
Settings" message and the mention returns `connectPrompted` for that persona — **no admission slot,
no `tenant_usage` row, no session row, no budget burn**. The `demo` harness needs no auth, so
`needsAuth` is false and every existing test/path is byte-for-byte unchanged. We do **not** write a
`marketing_tasks` row for a connect prompt (no session to reference); the in-channel message is the
artifact.

### 6. Settings surface — connect without ever echoing the token
`GET /me/agent-credentials` returns `{ connected, fingerprint, connectedAt }` (never the token).
`PUT` accepts `{ token }` (write-only), `DELETE` disconnects. The web **Connect Claude** panel shows
connected/not-connected, masks the paste field, and never renders the stored value back. Auth is the
standard `requireIdentity` workspace guard; the credential is workspace-scoped.

## Consequences
- **Owner step is one paste** (`claude setup-token` → Settings → Connect Claude). The runbook also
  documents the optional operator fallback (`fly secrets set -a reload-api ANTHROPIC_API_KEY=…`).
- **Metering, budget/402, kill switch, maintenance, approval-gated external sends, Braintrust** are
  all inherited unchanged — verified by the headline integration test (session → reply → metered).
- **Compliance:** a per-tenant boundary that cannot pool a subscription, with the token encrypted at
  rest and never returned by any API. The trust boundary is unchanged from #25.
- **Trade-off:** flipping `AGENT_HARNESS=claude-code` on Fly means a workspace with no token gets the
  connect prompt rather than the old demo echo — intended; the demo echo was never useful in prod.
