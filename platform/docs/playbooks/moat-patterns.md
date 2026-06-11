# Moat Patterns — what to compound, and how to measure it (#103)

Agents consult this at **spec time** (idea-refine / Venture Loop intake) to choose which durable
advantage a venture compounds, and what concrete accruals to record into the moat ledger
(`moat/score.ts`, `moat_ledger`). Premortem #4: anything built from public knowledge is rebuildable —
a moat is the thing that gets *harder to copy the longer the venture runs*.

Every pattern maps to one of the four scored dimensions. Pick at least one primary moat and record
its accruals with provenance so the score (and the #104 stagnation flag) reflects reality.

## 1. Data flywheels → `proprietaryData`

Usage produces data that makes the product better, which attracts more usage. The data asset is
proprietary and compounds; a competitor starting today has none of it.

- **Examples:** labeled outcomes from real users, a corrections/feedback corpus, a behavior graph.
- **Record:** rows/events of *proprietary, non-public* data accumulated. Unit: `rows`, `labels`,
  `events`. Provenance: which pipeline/table produced it.
- **Stagnation smell:** data volume flat week-over-week ⇒ the flywheel isn't turning.

## 2. Workflow embedding → `switchingCosts`

The product becomes the place work *happens*, not a tool visited. Leaving means rebuilding workflow,
re-training a team, and abandoning configured state.

- **Examples:** saved workflows/automations, team-configured templates, historical state users depend on.
- **Record:** count of embedded workflows / configured automations / dependent records per account.
  Unit: `workflows`, `automations`. Provenance: the feature that captured the embedding.
- **Stagnation smell:** users still treat it as a single-task tool (no saved state accruing).

## 3. Marketplace / network liquidity → `distributionLockIn`

Each new participant makes the product more valuable to everyone else; distribution becomes
self-reinforcing and a late entrant faces a cold-start they can't price around.

- **Examples:** two-sided marketplace match density, integration directory breadth, referral graph.
- **Record:** active participants / completed matches / live integrations / inbound referral edges.
  Unit: `integrations`, `matches`, `referrals`. Provenance: the network the metric is measured on.
- **Stagnation smell:** liquidity (match rate, fill time) not improving as participants grow.

## 4. Compliance / integration depth → `switchingCosts` + `distributionLockIn`

Hard-won certifications, deep system-of-record integrations, and regulatory approvals are slow and
expensive to replicate — they lock in regulated buyers and raise the bar for new entrants.

- **Examples:** SOC2/HIPAA/FedRAMP attestations, certified integrations with systems of record,
  data-residency guarantees.
- **Record:** certifications achieved, certified integrations shipped, regulated tenants onboarded.
  Unit: `certifications`, `integrations`, `tenants`. Provenance: the attestation/contract.
- **Stagnation smell:** no new depth added while the sales motion still hits compliance objections.

## 5. Accumulated evals & skills → `accumulatedEvals`

The platform's *own* compounding advantage: a growing eval suite, a library of proven skills/agents,
and tuned prompts that make every future venture cheaper and better. This is the moat the agent fleet
builds for itself.

- **Examples:** passing eval cases, reusable skills, tuned harness configs proven in production.
- **Record:** eval cases added, skills promoted to the shared library, reusable agents shipped.
  Unit: `evals`, `skills`, `agents`. Provenance: the eval suite / skill registry.
- **Stagnation smell:** ventures keep re-solving the same problems; nothing is being promoted to reuse.

## Using the ledger

1. At spec time, name the **primary** moat dimension and a target accrual rate.
2. As the venture runs, record concrete accruals (`POST /workspaces/:wid/ventures/:vid/moat`) with
   honest `magnitude`, `unit`, and `provenance` — the score is only as true as the ledger.
3. The Founder Console flags any venture with **zero** accrual over `stagnationWindowDays` — treat a
   flag as the #107 pivot/kill prompt, not a number to game.
