# ADR-0196: Legal & Compliance Pack per venture

- **Status:** Accepted (shipped in PR for #196)
- **Date:** 2026-06-13
- **Context issue:** [#196](https://github.com/gagan114662/agent-skills/issues/196)
- **Premortem:** [#200](https://github.com/gagan114662/agent-skills/issues/200) (failure mode #4 — legal is
  an IRREVERSIBLE class: pre-commitment constraints + human, never post-hoc review)
- **Spec:** [docs/specs/196-legal-compliance-pack.md](../specs/196-legal-compliance-pack.md)
- **Builds on:** [ADR-0114](0114-customer-voice-loop.md) (the feature-module shape: pure logic + injected
  IO seams + `caps.ts` default-OFF + `default.ts` wiring + one route + tables + migration, outbound reuses
  the #13 gate with zero `policy.ts` change), [ADR-0013](0013-approval-gates.md) (sensitive-by-default
  `external.send` = the owner-review decision queue), [ADR-0151](0151-ona-governance-trust.md) (the
  `EgressEnforcer` chokepoint pattern this mirrors for compliance), [ADR-0153](0153-marketing-site-machine.md)
  (publish-as-gated-`external.send`), [ADR-0146](0146-constitution-enforcement.md) (deterministic scorer →
  escalate-to-owner hard-stop), [ADR-0099](0099-disaster-recovery.md) (by-issue numbering).

> **Numbering note.** Spec/migration/ADR all use the `0196` slot (the issue number), per the by-issue
> numbering convention (ADR-0099's note) — to dodge sibling-workspace collisions in the shared sequence.

## Context

An autonomous company that breaks the law autonomously is a liability machine. Legal exposure —
deliverability bans, brand/trademark collisions, regulated-industry violations, mishandled data-subject
rights — is in the premortem's **irreversible** class (#200, failure mode #4): you cannot un-send a
non-compliant blast, un-collide a trademark, or un-violate HIPAA with a post-hoc review. So compliance has
to be a *generated, versioned, enforced artifact* with bounded blast radius — **not** a thing the fleet is
trusted to "do right".

Five obligations, each with a different enforcement shape:

1. **Docs** (ToS + privacy) are *judgment territory* — generate them from venture facts, version them, but
   never publish autonomously; a human owner reviews each publish.
2. **Email/marketing compliance** (CAN-SPAM/CASL/GDPR) must be **enforced in code at the send layer**, not
   by agent goodwill — an agent that "forgets" the unsubscribe footer must be physically unable to send.
3. **Naming** (trademark/domain collision) must be checked *before purchase* — but the #187 venture
   factory that would call it does not exist yet.
4. **Data rights** (export/deletion) must be honored end-to-end and audited.
5. **Disclaimer rails** — generated legal text must never be presented as counsel, and a regulated-industry
   venture must **hard-stop** to a human.

## Decision

1. **Mirror the Customer Voice loop (#114) exactly.** A `src/legal/` module: pure logic (`generate.ts`,
   `compliance.ts`, `precheck.ts`, `regulated.ts`) + injected IO seams (`service.ts`) + `caps.ts`
   (default-OFF) + `default.ts` production wiring + one `routes/legal.ts` + six additive tables + one
   migration (`0196`). Every outbound action (publishing a doc, surfacing a naming decision) becomes a
   **pending #13 `external.send`** — zero change to `approvals/policy.ts` or the executor.

2. **Docs are generated, content-addressed, and gated.** `composeDocument(kind, facts)` is pure and
   deterministic: the `version` is a short hash of the rendered body, `sourceFactsHash` fingerprints the
   facts it was generated from. A *material change* = the facts that generated the published doc no longer
   fingerprint the same → regenerate + a fresh owner-review approval. Determinism is what makes versioning
   and change-detection trustworthy. Auto-regeneration is gated behind `legal.autoRegenerate` (default OFF);
   publishing is *always* the #13 human gate regardless.

3. **CAN-SPAM/CASL/GDPR is enforced at the one physical chokepoint, not in agent prompts.** A new
   `ComplianceEnforcer` seam sits in `makeExternalSend` alongside the `#151 EgressEnforcer`: where egress
   decides *where* a send may go, compliance decides *whether it is lawful to send to this recipient*. The
   rule is the pure `decideCompliance` (suppression list → CAN-SPAM unsubscribe+postal footer → CASL/GDPR
   consent, in precedence order); the production enforcer resolves suppression/consent state, applies it,
   records the decision to the append-only `compliance_events` audit, and **blocks the send** (an
   `ActionExecutionError`, exactly like an egress block). Because the recorded-only `external.send` carries
   no body, the compliant footer is declared *structurally* in the action payload's `compliance` envelope
   and enforced there — an email with no declared unsubscribe is physically un-sendable.

4. **Naming pre-check is a clean interface with a stubbed caller.** `NamingPrecheck.check({name, domains})`
   is the interface the #187 factory will call before purchase; the shipped impl is a **deterministic
   stand-in** (no real WHOIS/USPTO, no model spend) — same name ⇒ same verdict, so it is testable and
   auditable. The result + a regulated-industry assessment are attached to a pending naming-decision
   approval. Swapping a real registrar/trademark API in later is a one-line change in `default.ts`.

5. **Regulated industries hard-stop to the owner.** `assessRegulated(facts)` is a transparent keyword
   classifier (health/finance/children/crypto/…); a match → `disposition: hard_stop`, and the naming/publish
   approval summary carries the `REGULATED_HARD_STOP_NOTICE`. It can never auto-clear (no workspace rule;
   sensitive-by-default). A false positive is a safe failure (the owner just reviews). Mirrors the #146
   constitution escalate-to-owner shape.

6. **Data rights are honored end-to-end and audited.** `requestDataExport` gathers everything the platform
   holds for a contact (consent + suppression state) and completes with that bundle as the audited result;
   `requestDataDeletion` adds the contact to the suppression list (so no future commercial send can reach
   them — enforced in code at the chokepoint) and completes. The `data_rights_requests` + `compliance_events`
   tables are the durable audit trail.

7. **Default OFF, owner workspace first.** `legal.enabled` gates the *risky* capability — blocking real
   sends + auto-regeneration. When off, the `ComplianceEnforcer` is a no-op (returns null), so existing
   deployments and every approval/egress test are **byte-for-byte unchanged**; the owner workspace opts into
   real send-blocking via a managed per-tenant override (the same rollout shape as `autoModel`/`voice`). The
   config block is registered in all five `config/schema.ts` sites + both `config/layers.ts` merge fns.

## Consequences

- **Bounded blast radius for the irreversible class.** A non-compliant send is blocked *at the wire*, not
  flagged after the fact. A regulated venture cannot launch without a human. A published doc was reviewed
  by a human. This is the #200 failure-mode-#4 discipline (pre-commitment + human) made real.
- **No new authority.** The pack publishes nothing and sends nothing on its own — it only generates drafts
  and opens #13 approvals. The owner's decision queue (#173) already surfaces them with zero new wiring.
- **Honest stubs.** The naming pre-check is deterministic, not a real trademark search; its own output says
  so, and the doc disclaimer says the docs are not counsel. We do not pretend to legal certainty we can't
  deliver.

## Alternatives considered

- **Enforce compliance in the marketing/voice send builders.** Rejected: an agent could submit an
  `external.send` by another path and bypass it. The executor chokepoint is the *one* place every send
  physically passes through — the same reason #151 put egress there.
- **Add new `ActionType`s (`legal.publish`, `naming.decide`).** Rejected: reusing sensitive-by-default
  `external.send` keeps `approvals/policy.ts` and every approval test untouched (the #114/#153 discipline).
- **Widen `venture_ideas` with legal facts.** Rejected: kept additive in `venture_legal_facts` so the pack
  is independent of every other branch's schema.
