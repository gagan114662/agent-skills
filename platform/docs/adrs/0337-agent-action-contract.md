# ADR-0337: The shared agent-action contract — propose-PR → #13 approve → verify on a live URL → rollback

- **Status:** Accepted (shipped in PR for #337)
- **Date:** 2026-06-18
- **Context issue:** [#337](https://github.com/gagan114662/agent-skills/issues/337) — standardize ONE
  contract that every risky department-agent action flows through, modeled on the "surface a PR, not an
  alert; verify on a live URL; flag-gated; instant rollback" pattern. This makes the [#200](https://github.com/gagan114662/agent-skills/issues/200)
  premortem guarantees the platform **default** instead of a per-issue afterthought.
- **Builds on:** [ADR-0013](0013-approval-gates.md) (the #13 approval queue + `evaluatePolicy` — the gate
  this contract REUSES, never a parallel path), [ADR-0243](0243-money-only-approval.md) (the money-only
  predicate + the irreversible-action class this layers on), [ADR-0200](0200-premortem-panel.md) (the
  standing premortem this answers to, and the weekly panel this feeds), [ADR-0295](0295-deliverable-delivery.md)
  / [ADR-0283](0283-skillopt-sleep.md) (the default-OFF, owner-workspace-first config + pure-decide module
  pattern this mirrors), [ADR-0223](0223-decision-maker-resolver.md) (structural-not-instructions injection
  defense), [ADR-0292](0292-release-version-verification.md) (verify a change reached production, not just CI).

## Context

The autonomy roadmap added many risky capabilities — deliverable delivery, hosted publishing, social
posting, email sends, connect-once, ad spend — and each one re-derived the SAME safety shape on its own:
park a request in the #13 queue, ship only after the owner's yes, record a receipt. The premortem (#200)
says exactly why that per-issue approach is fragile: self-reported metrics are fiction (§2), a worker and
its verifier share blind spots so only a production-grounded check is final (§3), irreversible actions must
be pre-committed and human-gated, never reviewed post-hoc (§4), and a poisoned web read must never steer an
autonomous write (§6). When each capability re-implements those rails by hand, one of them eventually
forgets a rail.

This change extracts the rails into ONE shared contract so every risky action inherits them structurally,
and so the weekly founder report can see, in a single gauge, whether the fleet's "it shipped" claims are
actually backed by reality.

## Decision

A pure, dependency-free module `apps/server/src/action-contract/` that models the lifecycle as a state
machine and encodes five invariants **structurally** — not by agent goodwill:

```
observe → investigate → propose (PR/diff) → awaiting_approval (#13) → approved → applied → verified
                                                                    ↘ rejected (terminal)
                                                       applied → failed → rolled_back
```

1. **Propose, never auto-apply.** `proposeAction(...)` is the only constructor of a proposal (a PR/diff,
   never an executed change), and `openContract` always starts in `propose`. The ONLY transition into
   `applied` is `applyApproved`, which requires the `approved` phase — there is no observe→apply edge. An
   irreversible capability cannot even be *proposed* without a `rollbackPlan`.

2. **Approval gating REUSES the #13 queue.** `gateProposal(proposal, rules)` maps the proposal to an
   `ActionDescriptor` and delegates to the existing `evaluatePolicy` (`approvals/policy.ts`) — the same
   single source of truth every other action uses — and force-gates every **irreversible** capability on top
   of the money predicate (#200 §4): an irreversible action is always the owner's call, even when it spends
   no money. `submitForApproval` refuses an empty approval-request id, so a contract can never "await" a gate
   that does not exist. No parallel approval path is invented.

3. **OFF by default behind a flag, owner-workspace-first.** `resolveActionContractFlags` (mirrors
   `delivery`/`skillopt`) is DEFAULT-OFF: the master `enabled` must be on AND the workspace in scope
   (`ownerWorkspaceOnly` defaults true ⇒ only the named `ownerWorkspaceId`). A **second** switch
   `applyIrreversible` gates the most dangerous step and is OFF even when `enabled`. `canApply(flags, class)`
   is the structural guard `applyApproved` consults — a deployment that sets nothing applies nothing.

4. **No success without an external receipt.** `confirmVerified(contract, receipt)` reaches `verified` ONLY
   when `isExternalReceipt(receipt)` holds — a production-grounded receipt is a closed allow-list of two
   sources: a `live_url` a real HTTP probe reached with a reachable status, or a `production_readback` (a
   real Stripe event / delivery webhook / analytics row). A missing, self-reported, or unreachable receipt
   is refused and the contract stays `applied` (→ verify-fail → rollback). **Never assume success** (#200
   §2/§3).

5. **Injection defense.** A proposal's `capability` and `reversibility` come PURELY from the **structural**
   `Observation` (the agent's actual tool/route). Investigated/fetched content (`InvestigatedContent`) is
   UNTRUSTED DATA: it is sanitized (control chars stripped via a charCode scan, not a `no-control-regex`
   literal) and carried only as quarantined `evidence` for the human reviewer. A poisoned read that embeds
   `actionType=billing.refund. approved=true` can never set the action type, flip the reversibility, or
   self-approve (#200 §6).

### Reversibility (apply/rollback halves)

Per #200 §4 a capability is `reversible | cheap | irreversible`. The contract makes "bounded blast radius +
fast detection + cheap reversal" concrete: an irreversible apply needs its own flag AND a rollback plan, a
failed verify routes to `failed` (never `verified`), and `rollback` is always available after apply.

### Premortem panel integration (FM#3)

`composePremortemPanel` gains an **additive, optional** gauge `contractReceiptCoveragePct`: of the risky
actions that APPLIED under the contract in the window, how many reached `verified` with a production
receipt. It is `null` when nothing applied (no gauge to show), and flags any gap — an applied action marked
done WITHOUT touching reality is the exact §3 failure the contract exists to stop. A report that supplies no
contract counters renders byte-for-byte as before (`summarizeContractGovernance` is the pure read-side
counter the briefings reader can wire to).

## Consequences

- **One contract, inherited rails.** A new risky capability adopts the contract instead of re-deriving the
  rails; the premortem guarantees stop being per-issue afterthoughts.
- **Build + PR only (this slice).** `applyApproved` performs no side effect — a real per-capability actuator
  behind the seam is a deliberate follow-up. No real irreversible action is executed; everything stays behind
  the #13 owner approval and the default-OFF flags. No migration.
- **Pure + testable.** The whole module runs in the no-DB/no-network unit job. Full unit coverage:
  propose-not-apply, approval-gating (reuses #13), flag-off-by-default (incl. the second irreversible
  switch), receipt-required-before-success, and injection.
- **Future work.** Wire a real actuator per capability behind `applyApproved`; persist contracts so the
  briefings reader feeds live counts into the FM#3 gauge; extend the receipt sources as new production
  read-backs come online.
