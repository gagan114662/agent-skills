# ADR-0231: Real-world tool surface + external-account onboarding into Settings + correct readiness signal

- **Status:** Accepted (shipped in PR for #231)
- **Date:** 2026-06-14
- **Context issue:** [#231](https://github.com/gagan114662/agent-skills/issues/231)
- **Premortem:** [#200](https://github.com/gagan114662/agent-skills/issues/200) — every OUTWARD or
  IRREVERSIBLE real-world action (an email sent = deliverability/brand, a social post, an external API
  call that may move money) stays behind the one #13 approval queue and is recorded-only until a human
  approves. A published page is a public brand surface so it is gated too (but reversible — it can be
  redeployed / taken down — so it is NOT counted as irreversible exposure).
- **Quarantine:** [#223](https://github.com/gagan114662/agent-skills/issues/223) — the real-world
  surface is split into two services with DISJOINT dependency sets. The read service (browse/research)
  has ONLY a reader and returns DATA; the actuator service (publish/send/post/call) has the publish
  provider + the #13 gate but NO reader. A poisoned web read has no actuator to reach — the same
  structural defense as the decision-maker.
- **Builds on:** [ADR-0192](0192-external-account-onboarding.md) (the human-once external-account vault
  + checklist this wires into Settings + the founder-console readiness signal),
  [ADR-0195](0195-venture-deploys.md) / [ADR-0073] (the deploy machinery the publish capability
  complements — `deploy/` provisions infra but never had an HTML-string → reachable-URL path),
  [ADR-0174](0174-agent-browser-runtime.md) (the enumerated-tool-surface + per-tool gating pattern this
  mirrors), [ADR-0013](0013-approval-gates.md) (the one approval queue; the new `realworld.publish`
  action kind is sensitive-by-default and never weakens it), [ADR-0099](0099-disaster-recovery.md)
  (by-issue migration/ADR numbering).

> **Numbering note.** Migration (`0231_realworld_tools.sql`) and ADR both use the `0231` slot (the issue
> number), per the by-issue numbering convention. The `realworld_artifacts` table is deliberately NOT
> `venture_`/`growth_`-prefixed so the #155 colocation gate does not class it as a governed metric
> surface.

## Context

Using the product as the owner surfaced three facts: (1) `founder-console.growth` showed
`externalPostsSubmitted = 0` / `acquisition = 0` — no agent had ever produced a real external artifact;
(2) Settings only offered Connect Claude + Connect Slack — there was no path to connect the accounts a
venture needs to operate (a domain, an ESP, analytics, ads, Stripe), even though the #192 onboarding
vault existed; and (3) `founder-console.setup.connected` read **0 even with Claude connected** — the
readiness signal was wrong. The fleet could only mutate internal state; it had no proven way to do real
work, and the product couldn't tell the owner what to connect for it to.

## Decision

1. **A verified, gated, injection-quarantined real-world tool surface** (`src/realworld/`): a bounded,
   enumerated vocabulary of seven tools — publish, send_email, post_social, browse, research,
   store_asset, call_api — each classified by reversibility (#200) and dataFlow (#223). The pure core
   (`tools.ts` + `decide.ts`) is the single source of truth and throws on an unknown tool, so a new tool
   can never silently bypass the gate. Outward/irreversible tools route through #13; read tools live in a
   reader-only service that cannot act. Account-dependent tools (publish needs hosting, send_email needs
   an ESP + registrar) are blocked with the exact list of what to connect.

2. **A real publish capability** (`src/realworld/publish/`): a `PublishProvider` seam with a non-reachable
   `DryRunPublishProvider` default and a real, dependency-free `GitHubPagesPublishProvider` (lazy, GitHub
   REST over `fetch`) that takes a page's bytes → a live `*.github.io` URL — the HTML-string → reachable-URL
   path the platform was missing.

3. **External-account onboarding wired into Settings** (`apps/web` `ExternalAccountsPanel`): the owner
   connects venture-operating accounts (hosting/ESP/registrar/analytics/ads/payments) over the existing
   #192 vault, and sees per-kind what's connected vs. still needed for real work.

4. **The readiness signal fixed**: `founder-console.setup.connected` now folds in the Claude subscription
   (#68 `workspace_agent_credentials`, the vault the pane previously ignored), and a new `setup.needed`
   surfaces exactly which external account kinds the owner must connect before a venture can do real work.

5. **Default OFF** everywhere: the `realworld` config block ships disabled and the publish provider stays
   `dryrun`. A canary (`scripts/realworld-canary.ts`) proves the path end-to-end against a real token —
   it parks a #13 approval, then (post-approval) publishes a real reachable page verified at HTTP 200.

## Consequences

- The fleet has a real, auditable way to act in the world, with every outward action gated and every
  artifact receipted in `realworld_artifacts`.
- The injection-quarantine boundary is preserved structurally (disjoint read/actuator deps), not by
  convention.
- The owner can now connect operating accounts from the product, and the console honestly reports both
  what's connected and what's still missing for real work.
