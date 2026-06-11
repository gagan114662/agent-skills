# Spec: Reload Platform — Ona-class governance & trust (Issue #151)

> Implements [#151](https://github.com/gagan114662/agent-skills/issues/151). Lifecycle: **DEFINE**
> artifact (`spec-driven-development`). Builds on [#68](../adrs/0068-subscription-first-agent-auth.md)
> (the per-tenant `SecretsResolver` + `crypto/secretbox` vault), [#25](25-cloud-execution.md) (the
> provision-time secrets seam + `AgentJob` runtime contract), [#13](../adrs/0013-approval-gates.md)
> (the human approval gate + the append-only `approval_events` audit trail), [#58](35-config-layering.md)
> (the layered, lockable config + the binary `dataPrivacyMode` egress primitive), [#3/#9](09-registry-rbac.md)
> (member/tenant identity + the IDOR/capability ladder), and
> [#149](https://github.com/gagan114662/agent-skills/issues/149) (the public landing site the
> `/security` page extends).

## ⚠️ Decision first — what we build vs. what we document
**We build the governance *primitives* (scoped credentials, egress allowlist, workspace roles) as pure
decision modules + seams, default-OFF; we do NOT build kernel-level network enforcement, a VPC, or SSO.**
See [ADR-0151](../adrs/0151-ona-governance-trust.md). Ona sells kernel-policy + VPC + SSO + SOC2; ipop's
honest second-wave answer is application-layer governance that is *real and testable today*, with the
heavier infrastructure (sandbox kernel egress enforcement, SSO/SAML, SOC2) listed as a **documented seam
+ roadmap**, never claimed as shipped. The `/security` page says exactly this — no fake certifications.

## Objective
**What:** Four additive, default-OFF capabilities:
1. **Per-agent scoped credentials** — the `SecretsResolver` gains an optional `(workspace, agent,
   purpose)` scope; a pure allowlist matrix decides which secret keys an agent may receive (scout reads
   the crawl token, never the Stripe key; postmark gets email creds only). Default-OFF ⇒ today's
   per-tenant resolution byte-for-byte.
2. **Egress domain allowlist** — a per-workspace config allowlist for cloud agent sessions; default
   deny-unknown when enabled; a pure `decideEgress` classifies each target `allow | deny | flagged`;
   violations are recorded to a durable, append-only audit table and surfaced as a flagged-domains
   report; the session's allowlist is injected into the `AgentJob` (the sandbox-enforcement seam).
3. **Teams / RBAC** — workspace members gain a role (`owner | approver | viewer`); only `approver`/`owner`
   may clear #13 approvals; `viewer` is read-only; email invites create a pending grant a recipient
   accepts. SSO is a documented seam (interface only). Default-OFF ⇒ today's "any human member clears".
4. **Trust surface** — a public `/security` page on the landing site describing the **real** guarantees
   already built (approval gates, tenant isolation, kill switch, budget caps, audit trail, scoped
   credentials, egress control). SOC2 / GDPR / SSO listed as roadmap. No certifications claimed.

**Why:** ona.com sells governance as the enterprise wedge. ipop already has the *mechanisms* (the #13
gate, #71 budget caps, #25 tenant isolation, the #68 sealed vault) but they are invisible and
coarse-grained. #151 sharpens them (per-agent, per-domain, per-role) and tells the truth about them on
a public page — turning latent guarantees into a sellable, honest trust story.

**Who:** A workspace **owner** configures roles, the credential matrix, and the egress allowlist (trusted
managed/repo config). An **approver** clears approvals. A **viewer** observes. Cloud **agent sessions**
receive only their scoped secrets + their egress allowlist. The public reads `/security`.

### Acceptance criteria (from #151)
1. `SecretsResolver.resolve(workspace, agent?, purpose?)` enforces an allowlist matrix; scout↛Stripe,
   postmark→email-only; **default-OFF ⇒ unchanged per-tenant resolution**; model-auth keys (#68) are
   never scoped away.
2. Per-workspace egress domain allowlist; default deny-unknown **when enabled**; flagged-domains report;
   violations to the audit trail; the allowlist reaches the cloud session (`AgentJob.egress`).
3. Members with roles (owner/approver/viewer); approver clears #13 approvals; viewer read-only; email
   invites; **SSO documented seam only**; **no weakening** of existing gates when default-OFF.
4. Honest public `/security` page (real guarantees + roadmap, no fake certs).
5. Pure modules + seams, default-OFF, tenant-scoped, migration `0151_`, TDD, spec + ADR, one PR.

## Design

### 1. Scoped credentials (`runtime/credential-scope.ts` — pure)
- **Matrix shape** (non-secret, lives in config): `{ enabled, purposes: { <purpose>: string[] },
  agents: { <agentName>: string[] /* allowed purposes */ } }`. The secret *values* never live here —
  only key NAMES grouped by purpose (the #57 convention). Example: `purposes.crawl = ["CRAWL_TOKEN"]`,
  `purposes.email = ["POSTMARK_TOKEN"]`, `purposes.payments = ["STRIPE_SECRET_KEY"]`;
  `agents.scout = ["crawl"]`, `agents.postmark = ["email"]`.
- **Pure decision** `allowedKeysForAgent(matrix, agentName, purpose?)` → the set of secret keys the
  agent may receive (union over its allowed purposes, optionally narrowed to one `purpose`). An agent
  absent from `agents` gets `[]` (deny-by-default) **when enabled**. `filterSecrets(secrets, allowed,
  alwaysKeep)` returns the scoped record; `alwaysKeep` = the #68 `AGENT_AUTH_KEYS` (the model credential
  is never scoped away — a scoped agent must still be able to run the model).
- **Seam** `ScopedSecretsResolver` decorates any inner `SecretsResolver`: `resolve(ws, scope?)` →
  `inner.resolve(ws)` then, **iff** the matrix is enabled and a `scope.agentMemberId` resolves to a
  persona name, filters. Disabled / no agent / no matrix ⇒ identical bytes (passthrough). The agentId→name
  lookup is an injected seam (`lookupAgentName`) so the decorator stays pure-of-DB and unit-testable.
- **Wiring** `runtime/manager.ts` passes `{ agentMemberId: session.agentMemberId }` to `resolve`.
  `runtime/default.ts` wraps the existing `SubscriptionSecretsResolver` in `ScopedSecretsResolver`.
  The ~8 workspace-only callers (billing/deploy/integrations/voice) keep calling `resolve(ws)` — the
  scope arg is optional.

### 2. Egress allowlist (`runtime/egress-allowlist.ts` — pure; `egress_violations` table)
- **Pure** `domainOf(target)` (host extraction, lowercased, port-stripped), `matchesAllowlist(domain,
  allowlist)` (exact + leading-`*.` wildcard), `decideEgress({ target, allowlist, enabled })` →
  `{ decision: "allow" | "deny" | "flagged", domain }`. `enabled:false` ⇒ always `allow` (today's
  behavior). Enabled + in-list ⇒ `allow`; enabled + not-in-list ⇒ `deny` (and the caller records a
  `flagged` violation). Unparseable target enabled ⇒ `flagged`/deny.
- **Config** `egress` block: `{ enabled?, allowlist?: string[] }`, default `{}` (off).
- **Audit** `egress_violations` (append-only, mirror `approval_events`): `id, workspace_id, session_id?,
  actor_member_id?, target, domain, reason, detail jsonb, created_at`. Repo `recordViolation` +
  `listViolations` (the flagged-domains report). Never updated/deleted.
- **Enforcement seams:** (a) the application chokepoint — the `external.send` executor consults
  `decideEgress`; a denied target records a violation + fails the action (the #13 trail already gates
  *whether* to send; egress gates *where*). (b) the cloud session — `AgentJob.egress` carries the
  resolved allowlist into `runtime.start`; the sandbox backend is the documented kernel-enforcement seam
  (today it is advisory/passed-through; Vercel-sandbox network policy is the future wire-up).

### 3. Teams / RBAC (`team/rbac.ts` — pure; `workspace_member_roles` + `workspace_invites`)
- **Roles** `owner > approver > viewer`. Pure: `roleRank`, `canClearApprovals(role)` (owner|approver),
  `canManageGovernance(role)` (owner — roles/invites/matrix), `isReadOnly(role)` (viewer),
  `decideInvite`. Default-OFF ⇒ when `rbac.enabled` is false OR the member has no role row, the approval
  routes keep today's `requireHuman`-only behavior (no weakening, no new lock-out).
- **Schema** `workspace_member_roles (workspace_id, member_id, role, granted_by, …)` UNIQUE(ws, member);
  `workspace_invites (workspace_id, email, role, token_hash, status, …)` — the token is sha-256 hashed
  (reuse #68 `tokenFingerprint`/auth hashing), accept flips `pending→accepted` and creates the member
  via the existing `createHumanMember` email seam.
- **Guard** `auth/guard.ts#requireWorkspaceRole(loadRole)` — parallel to `assertWorkspace`/`requireHuman`;
  injected role loader so it is testable. Applied in `routes/approvals.ts` approve/reject (when enabled)
  and the new `routes/governance.ts` (owner-only role/invite/matrix management + the egress report).
- **SSO** `team/sso.ts` — an `SsoProvider` interface (`resolveAssertion`) + a `DisabledSsoProvider`
  default that always declines. No network, no IdP — the documented seam, per the issue.

### 4. Trust page (`apps/web` — `/security`)
- A public, lazy, code-split `Security` component reachable at `/security` (logged-out + logged-in),
  added to the landing `AuthGate` route switch. All copy from `brand.ts` (brand-scan compliant). Three
  honest sections: **What protects your work today** (the real, shipped guarantees), **On the roadmap**
  (SOC2 Type II, GDPR DPA, SSO/SAML — explicitly "not yet certified"), **What we do not claim** (no
  current certifications; we describe mechanisms, not audits). A footer link from the landing page.

## Non-goals / explicit seams
- No kernel/VPC network enforcement (egress is application-chokepoint + advisory session env today).
- No real SSO/IdP (interface only). No SOC2/GDPR audit (roadmap copy only).
- No change to the #13 decision semantics, the #71 budget caps, or the #68 vault — only additive scoping.

## Test plan (TDD)
- **Pure (unit):** `credential-scope` (matrix allow/deny, purpose narrowing, model-key always-kept,
  disabled passthrough), `egress-allowlist` (exact/wildcard/deny/flagged/disabled, host parsing),
  `team/rbac` (role ranks, clear/manage/read-only, invite decision), `ScopedSecretsResolver`
  (passthrough vs. filtered via fake lookup).
- **Seam (unit):** `external.send` executor denies + records a violation under an enabled allowlist;
  `AgentJob.egress` populated when enabled.
- **Integration (DB):** roles repo grant/list; invite create→accept→member; egress_violations
  record→list; approver clears an approval while viewer is 403 (enabled) and any-human clears (disabled).
- **Web:** `/security` renders the real-guarantees sections + roadmap; brand-scan passes.
