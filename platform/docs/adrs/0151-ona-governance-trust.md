# ADR-0151: Ona-class governance & trust — scoped credentials, egress control, teams/RBAC, an honest trust page

- **Status:** Accepted (Gagan approves defaults-and-go; **video gate waived by the owner** — issue #151)
- **Date:** 2026-06-11
- **Context issue:** [#151](https://github.com/gagan114662/agent-skills/issues/151) (second-wave gap
  coverage vs ona.com: kernel policy, scoped credentials, network control, org permissions, SOC2/GDPR)
- **Builds on:** [ADR-0068](0068-subscription-first-agent-auth.md) (the per-tenant `SecretsResolver`,
  `AgentAuthResolver`, `crypto/secretbox` vault, `AGENT_AUTH_KEYS`), [ADR-0013](0013-approval-gates.md)
  (the human gate + append-only `approval_events` audit), [ADR-0035](0035-config-layering.md) (layered
  lockable config + `dataPrivacyMode` egress primitive), #25 (provision-time secrets seam + `AgentJob`),
  #3/#9 (member/tenant identity, IDOR + capability ladder), #149 (the public landing site).
- **Spec:** [151-governance-trust.md](../specs/151-governance-trust.md).

## ⚠️ Decision first — application-layer governance that is real today, not infrastructure we can't yet honor
Ona sells **kernel-level** network policy, a per-run **VPC**, **SSO**, and **SOC2/GDPR**. We do not have
those and will not pretend to. The honest, shippable answer is to sharpen the governance *mechanisms we
already own* — the #68 sealed vault, the #13 human gate, the #71 budget caps, the #25 tenant isolation —
into **per-agent, per-domain, per-role** controls, all **pure decision modules + seams, default-OFF**, and
to publish a `/security` page that describes exactly those mechanisms and lists the infrastructure (kernel
egress enforcement, SSO/SAML, SOC2, GDPR DPA) as a **documented seam + roadmap**. The alternative —
claiming certifications or building a half-real VPC — is both dishonest and a far larger lift than one PR.

## Decisions

### 1. Scoped credentials are a pure matrix + a passthrough decorator (no schema, no secret in config)
`runtime/credential-scope.ts` is pure: an allowlist matrix (purposes→key-NAMES, agents→purposes) decides
`allowedKeysForAgent(matrix, agent, purpose?)`; `filterSecrets(secrets, allowed, alwaysKeep)` applies it.
The matrix lives in the **config** layer (non-secret names only — secret *values* stay on the #68/#25
secrets path, never in config). `ScopedSecretsResolver` **decorates** the existing
`SubscriptionSecretsResolver`: disabled, no agent, or no matrix ⇒ **identical bytes** (today's per-tenant
resolution). The #68 model-auth keys are in `alwaysKeep` — a scoped agent can still run the model.
**Why a decorator, not a rewrite:** the `SecretsResolver` interface gains only an *optional* `scope`
arg, so the ~8 workspace-only callers (billing/deploy/integrations/voice) are untouched, and the single
session call site (`runtime/manager.ts`) already has `session.agentMemberId` in scope.
**Rejected:** a per-agent credentials *table*. The matrix is policy, not secrets; storing it in config
reuses the #58 layered-lock (a managed layer pins it) and keeps zero new secret-bearing rows.

### 2. Egress is a pure allowlist enforced at the application chokepoint, with the sandbox as a seam
`runtime/egress-allowlist.ts#decideEgress` is pure (`allow | deny | flagged`, exact + `*.`-wildcard,
disabled⇒allow). It is enforced **today** at the one real outbound funnel — the `external.send` executor
(#13) — where a denied target records an `egress_violations` row and fails the action. For cloud sessions
the resolved allowlist rides on `AgentJob.egress` into `runtime.start`; the **sandbox backend is the
documented kernel-enforcement seam** (advisory/passed-through today; Vercel-sandbox network policy is the
future wire-up). **Why not claim kernel enforcement now:** we don't run a network-policy sandbox yet, so
enforcing only at the application chokepoint is the truthful boundary — and the `/security` page says so.
`egress_violations` mirrors `approval_events`: **append-only, never updated/deleted**, written in the same
path as the decision, so the flagged-domains report can never drift from what actually happened.

### 3. RBAC roles tighten, never loosen — default-OFF preserves "any human clears"
`team/rbac.ts` is pure: `owner > approver > viewer`; `canClearApprovals` = owner|approver,
`canManageGovernance` = owner, `isReadOnly` = viewer. The role check is **additive on top of** the #13
`requireHuman` gate and only **when `rbac.enabled`**: an enabled workspace requires approver/owner to
clear; a `viewer` is 403. **Default-OFF or a member with no role row ⇒ today's behavior unchanged** (any
human member clears) — the issue's "no weakening of existing gates" is satisfied because the new gate can
only *add* a requirement, never remove `requireHuman`. Roles + invites are two additive tables;
`requireWorkspaceRole(loadRole)` is a guard parallel to `assertWorkspace` with an injected loader (so it
unit-tests without a DB). Email invites reuse the existing `createHumanMember({email})` seam; the invite
token is sha-256 hashed at rest (reuse #68 hashing) — the raw token is shown once, never stored.
**SSO is an interface only** (`team/sso.ts`: `SsoProvider`/`DisabledSsoProvider` that always declines) —
the issue scopes SSO to a documented seam, and a real IdP integration is its own future ADR.

### 4. The `/security` page is honest by construction (copy from `brand.ts`, no certifications)
A public, lazy `Security` component reached via the #149 `AuthGate` route switch. It has exactly three
sections: **what protects your work today** (only shipped guarantees — approval gates, tenant isolation,
kill switch, budget caps, audit trail, scoped credentials, egress control), **on the roadmap** (SOC2 Type
II, GDPR DPA, SSO/SAML — each labelled "not yet certified / not yet built"), and **what we do not claim**
(no current certifications; we describe mechanisms, not third-party audits). A test asserts the roadmap
items are framed as future and that no certification is asserted as current — the honesty is enforced, not
just intended.

## Consequences
- **Positive:** a sellable, *truthful* governance story; finer-grained controls (per-agent secrets,
  per-domain egress, per-role approvals) with zero new secret-bearing storage; every new control is
  default-OFF so no existing deployment changes behavior; the audit trail gains an egress dimension.
- **Negative / deferred:** egress is not kernel-enforced (application chokepoint + advisory session env);
  SSO and SOC2/GDPR are seams/roadmap, not shipped — the `/security` page is explicit about this.
- **Migration `0151_`** (number-by-issue to dodge sibling collisions): `workspace_member_roles`,
  `workspace_invites`, `egress_violations` — all additive; the down drops exactly those three.
