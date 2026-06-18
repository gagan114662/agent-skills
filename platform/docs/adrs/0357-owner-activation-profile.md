# ADR-0357: owner-workspace full-activation profile for production dogfood

- **Status:** Accepted (build + PR only — no deploy, no secret, no live config flip; see "Out of scope").
- **Date:** 2026-06-18
- **Context issue:** [#357](https://github.com/gagan114662/agent-skills/issues/357) — give the owner a
  single, reviewed, reversible way to turn the ENTIRE product ON for THEIR OWN workspace only in production
  (real actions, #13-gated), while customer tenants stay byte-for-byte unchanged.
- **Builds on:** the #58 layered config loader + the per-tenant `[workspace.<id>]` managed layer
  ([ADR-0035]); the owner-workspace-first rollout pattern shared by `venture` ([ADR-0228]),
  `emailDeliverability` ([ADR-0268]), `connectOnce` ([ADR-0258]), `delivery` ([ADR-0295]),
  `worktreePool` ([ADR-0343]) and others; the #13 approval queue + premortem rails ([ADR-0200]).

## Context

Every product loop and surface (~60 config blocks) already ships **default-OFF**, and most expose an
owner-workspace-first rollout (`enabled` + `ownerWorkspaceOnly` + `ownerWorkspaceId`) plus a managed-layer
lock at `/etc/reload/managed.toml`. What was missing was a **single, reviewed, reversible artifact** that
turns the whole thing on for the owner's own workspace so they can dogfood every surface and loop
end-to-end in production with **real actions** — without touching any customer tenant and without letting a
real/irreversible action happen without a human.

Doing this ad hoc (flipping dozens of env markers by hand) is error-prone: it is easy to enable a feature
globally instead of for one tenant, or to flip an autonomous switch while wiring a live provider. The
premortem (#200) demands the blast radius be **one tenant**, that **no irreversible action be
pre-committed**, and that activation be **reversible by one action**.

## Decision

Ship a parameterized managed-layer profile and the docs/tests that make it safe to operate — and nothing
that changes the running app.

1. **`platform/deploy/managed.owner-activation.example.toml`.** A single `<OWNER_WORKSPACE_ID>` placeholder
   profile. **100 % of the activation is scoped under `[workspace."<OWNER_WORKSPACE_ID>".*]`; the global
   `[settings]` table is empty.** This is the isolation guarantee at the *layer* level: `loadConfig(owner)`
   is fully activated, while `loadConfig(any-other-id)` and `loadConfig(undefined)` resolve to
   `CONFIG_DEFAULTS` byte-for-byte. Each owner-first feature additionally carries
   `ownerWorkspaceOnly = true` + `ownerWorkspaceId` as defense-in-depth (the resolution helpers still gate
   it to the owner even if mis-pasted globally). Live provider switches are flipped so real actions are
   *possible*: `billing.provider = "stripe"`, `emailDeliverability.liveSendEnabled = true`,
   `capabilityTokens.liveMintEnabled = true`, `connectOnce`/`connectClaude` enabled,
   `ventureDeploys.provider = "vercel"`, `ads.perActionCapCents` set, `realworld.publishProvider`, etc.

2. **The #13 invariant: real actions are possible, never autonomous.** Every autonomous-without-approval
   switch is pinned to its safe value **explicitly** (not left to default), so the invariant is visible in
   the file, locked by the managed layer, and asserted in the test: `selfHealing.autoRemediate /
   allowRollback / allowScale / preCommitRollback / preCommitScale = false`,
   `requireApprovalForDestructive = true`, `supportDesk.autoSend = false`, `voice.autoTriageDraft = false`,
   `verification.autoSendReversible = false` (`requireProductionGrounding = true`),
   `acquisition.autoSend = false`, `ventureDeploys.preCommitProdPromote = false`
   (`requireApprovalForProdPromote = true`), and skillopt only stages #13 proposals (no auto-adopt knob
   exists). Money/irreversible actions remain structural #13 always-gates regardless of any flag.

3. **`docs/runbooks/owner-activation.md`.** The exact ordered operator steps — `flyctl secrets set` for each
   live provider credential (PLACEHOLDER values only), the managed.toml/env change, the deploy command,
   how to verify each surface, and how to revert (delete the one file / unset the marker). Activation is
   **sequenced in three phases** (1 coordination + UI + observability-read; 2 growth read/proactive;
   3 real-action connectors last) so it is brought up incrementally.

4. **Honest `coming_soon` / dry-run list.** Features whose flag turns on but which stay `coming_soon`/
   dry-run until a live provider client is wired are documented up front: capability-token verify (#336),
   connect-once OAuth (#258), connect-Claude (#262), social aggregator (#269), outreach sender (#225),
   SEO/analytics read providers (#294/#270), Slack digest (#170), reliability email paging (#148).

5. **Loader unit test** (`platform/apps/server/test/unit/owner-activation-profile.test.ts`). Reads the
   **real shipped file**, substitutes the placeholder, and proves both halves of the guarantee: every
   master switch + live provider is ON and every owner-first resolver in scope for the owner; and
   `CONFIG_DEFAULTS` byte-for-byte for any other id and for server-wide reads. It also asserts the #13
   invariant (all autonomous switches OFF) and that the global `[settings]` table is empty.

## Out of scope (explicitly NOT in this PR)

No deploy, no secret set, no live app config flipped. Activation requires the owner to **(a)** provide their
real workspace id, **(b)** set the secrets, **(c)** run the deploy — none of which this PR does.

## Alternatives considered

- **Put the activation in the global `[settings]` table** and rely solely on each feature's
  `ownerWorkspaceOnly` resolver. Rejected: it works for owner-first features but leaks for plain-`enabled`
  blocks (finance, billing provider, etc.) that have no per-workspace resolver, and it makes the isolation
  test weaker (must call every resolver instead of a single deep-equal). Per-tenant table scoping isolates
  at the layer level and is trivially provable.
- **A code flag / admin endpoint to "activate everything."** Rejected: a new mechanism the premortem would
  have to re-audit, vs. the existing, already-locked managed layer. The issue explicitly requires using the
  real loader mechanisms, not inventing new ones.
- **Flip the autonomous switches on too** ("full autonomy dogfood"). Rejected outright: it deletes the #13
  gate that is the whole point. Real actions must be *possible* and *human-approved*, not autonomous.

## Consequences

- The owner can dogfood the entire product on one workspace with one reviewed file; reverting is one
  deletion + redeploy. Customer tenants are provably unaffected.
- The autonomous-OFF invariant is enforced by test, so a future schema-default change cannot silently flip
  it for this profile.
- Some surfaces honestly read `coming_soon`/dry-run until their live client lands; expectations are
  documented rather than surprising.

[ADR-0035]: 0035-config-layering.md
[ADR-0200]: 0200-premortem-panel.md
[ADR-0228]: 0228-fundability-gate-default.md
[ADR-0258]: 0258-connect-once-integrations.md
[ADR-0268]: 0268-email-deliverability-compliance.md
[ADR-0295]: 0295-deliverable-delivery.md
[ADR-0343]: 0343-treehouse-worktree-pool.md
