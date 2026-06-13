# ADR-0192: External account onboarding — human-once setup, agent-forever operation

- **Status:** Accepted (shipped in PR for #192)
- **Date:** 2026-06-13
- **Context issue:** [#192](https://github.com/gagan114662/agent-skills/issues/192)
- **Answers to:** [#200](https://github.com/gagan114662/agent-skills/issues/200) (the standing premortem — every
  roadmap item must answer its failure modes; see "Premortem" below).
- **Builds on:** [ADR-0068](0068-subscription-first-agent-auth.md) (the per-tenant write-only vault:
  `crypto/secretbox` seal/open/fingerprint + the one-row-per-workspace no-pool invariant + the
  inject-as-env-never-read-back discipline), [ADR-0013](0013-approval-gates.md) (the decision queue +
  `evaluatePolicy` + the pending-approval seam blocked work parks into), [ADR-0050](0050-founder-console.md)
  (the read-only aggregate pane pattern), [ADR-0170](0170-slack-native-integration.md) (the owner-DM +
  Block Kit surface), [ADR-0041](0041-deploy-to-live-url.md) (the `DeployProvider` dry-run-default /
  lazy-real adapter the `DnsProvider` mirrors), [ADR-0099](0099-disaster-recovery.md) (by-issue migration
  numbering).

> **Numbering note.** Migration + ADR use the `0192` slot (the issue number), per the by-issue
> convention (ADR-0099's note), to dodge sibling-workspace collisions in the shared sequence.

## Context

The owner directive is a hard boundary: **agents must never create accounts, accept Terms of Service, or
handle credentials.** A human does that ONCE per service; the fleet then operates through the vault
forever. Today this handoff is ad-hoc chat — a venture stalls, someone notices, keys get pasted into a
channel (leaking them), and nobody can later prove what the fleet did to a domain.

The premortem (#200) sharpens the constraints. Failure-mode 4 (reversibility classes): buying a domain or
opening a payment account is MONEY → **irreversible** → a human pre-commitment, never a post-hoc agent
action; but DNS/SSL/SPF/DKIM/DMARC are **reversible** → the agent should do them autonomously, with
receipts. Failure-mode 6 (injection defense): a credential a web-reading agent could read back or log is a
leak waiting to happen — keys must be write-only. Failure-mode 5 (owner attention is budgeted): blocked
work must surface in the EV/age-ranked decision queue, not fail silently.

## Decision

Add an **`onboarding/` feature** that reuses the #68 vault shape for arbitrary services, parks blocked
work in the #13 queue, and adds a DNS adapter mirroring #73. **Default-OFF** behind an `onboarding` config
flag (owner workspace opts in first).

1. **Write-only vault for arbitrary services.** `external_credentials` is one row per (workspace, service)
   — the same no-pool invariant as #68. Each secret value is stored **sealed** (`crypto/secretbox`,
   AES-256-GCM, transparent when no key) under its env-var name; `env_keys` is the non-secret list of
   names; `fingerprint` is non-reversible. `getServiceStatus`/`listServiceStatuses` **never select the
   secrets column**, so no status API can leak a key. The only read-back is `resolveServiceSecrets` /
   `resolveAllServiceSecrets`, used solely to inject env into a runtime (where the SessionManager redactor
   scrubs values from output). This is the injection-defense answer: a key is structurally unreadable by
   the agent that uses it.

2. **Needs detection → a SETUP request → the decision queue.** Pure `decideSetupNeeded(required,
   connected)` returns a spec per missing service carrying which service / plan / scopes / why / projected
   cost (acceptance 1). The service files it to `external_setup_requests` AND submits a #13 approval under
   a new `setup.external_account` action type — sensitive by default — so it **parks visibly and ages** in
   the founder-console + briefings decision queue (acceptance 5). `requiresHuman` is always true for an
   external account (the directive); `reversibility` (registrar/payment = irreversible) feeds the #200
   irreversible-action count.

3. **Owner pastes keys once; agents use them forever.** `PUT /me/external-credentials/:service` seals the
   pasted map and flips the request to `connected`; the checklist renders in the console pane and a Slack
   Block Kit message (acceptance 2). A new **`ExternalSecretsResolver`** composes into the existing #25
   resolver chain and injects every connected service's secrets — **gated by `onboarding.enabled`**, so a
   workspace that hasn't opted in (or has nothing connected) gets a byte-for-byte no-op.

4. **Domains: owner buys (money), agent configures (reversible) with receipts.** Buying the domain is an
   irreversible setup request the owner fulfils. After that, `DnsProvider` (default `DryRunDnsProvider`,
   no network; real adapters lazy-loaded via `createDnsProvider`, mirroring #73) configures + **verifies**
   the planned SPF/DKIM/DMARC/SSL/app records — pure builders in `dns/records.ts` — and every result is
   written immutably to `dns_receipts` (acceptance 3). Verification re-checks published records (the
   reality-touching tier, #200 failure-mode 3).

5. **Hygiene: rotation reminders + graceful revocation.** `decideRotationReminders` (pure) surfaces
   credentials past their rotation age. `revokeServiceCredentials` marks the row `revoked` and wipes the
   sealed values (keeping the audit trail); `decideCapabilityStates` then derives which dependent
   capabilities are **offline**, with a reason — never a silent failure (acceptance 4).

## Consequences

- **The directive is enforced by structure, not discipline.** There is no API that returns a stored key;
  agents receive secrets only as injected, redacted env. Account creation / ToS / key entry are human-only
  routes.
- **Blocked work is loud.** A missing service produces a queued, aging #13 approval — the owner sees it in
  the same decision queue they already triage, ranked by age.
- **Honest, reversible automation.** The agent only touches the reversible half (DNS records) and leaves
  proof (receipts); the money half (domain/payment) stays a human pre-commitment.
- **Zero blast radius by default.** With `onboarding.enabled` off and nothing connected, the resolver is a
  no-op and the routes' risky writes 409 — the deployment behaves exactly as before. One additive,
  sibling-safe migration (`0192`), three tables, no change to any existing business-domain table.

## Alternatives considered

- **Reuse the #68 `workspace_agent_credentials` table for every service.** Rejected: that table is keyed
  by workspace alone (one subscription token); arbitrary services need a (workspace, service) key and a
  per-service status/scope/rotation. A parallel table keeps #68 untouched and the no-pool invariant intact.
- **Add the secrets to `AGENT_SECRET_KEYS` passthrough.** Rejected for the same reason `BillingSecretsResolver`
  exists (#98/#184): that passthrough injects a key into **every** agent. The dedicated resolver scopes
  injection to connected services per workspace and composes with the #151 per-agent scoping decorator.
- **Let agents buy domains within a dollar ceiling.** Rejected per #200 failure-mode 4: a domain purchase
  is irreversible (brand/legal), so it stays a human pre-commitment, not a post-hoc-reviewed agent spend.
- **Surface blocked setup as a bespoke notification.** Rejected: the #13 decision queue already ages and
  ranks owner decisions; a new channel would be a second place to look and could silently rot.
