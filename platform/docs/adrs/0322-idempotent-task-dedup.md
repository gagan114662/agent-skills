# ADR-0322: Idempotent task / draft dedup — the fleet stops re-opening the same job

- **Status:** Accepted (shipped in PR for #322)
- **Date:** 2026-06-17
- **Context issue:** [#322](https://github.com/gagan114662/agent-skills/issues/322) — the SEO board grew six+
  identical "Audit our website's homepage for SEO and summarise the top quick wins" tasks and the Spend
  Approval column held a dozen near-identical drafts of the same audit. The fleet kept re-creating the same
  task instead of deduping, which spammed the board and the approval queue and made the product read as
  broken / low-trust.
- **Builds on:** [ADR-0123](0123-marketing-department-fleet.md) (the @mention → real session launch path and
  the `marketing_tasks` records this dedups; the owner BRIEF composer of #235 is a thin front door onto the
  same path), [ADR-0295](0295-deliverable-delivery.md) (the DEFAULT-OFF,
  owner-workspace-first `resolveDeliveryFlags` rollout pattern this mirrors), [ADR-0200](0200-premortem-panel.md)
  (the standing premortem — production-grounded verification, idempotent creation, injection defense).

## Context

Three surfaces all funnel an objective through the **same** launch seam — `MarketingMentionService.launch`:

1. the first-run auto-run (#301) that fires a Scout site-audit when the board is empty,
2. the owner BRIEF composer (#235), and
3. a re-typed `@mention` in a department channel (#123).

`launch` opened a fresh `marketing_tasks` row **and** a fresh agent session on **every** call, with no check
for work the fleet was already doing. A flaky auto-run that retries, or an owner who briefs the same goal
twice, therefore multiplied into N identical tasks — and because each session completes into an
`agent.deliverable` review card (#248), into N identical drafts piled in Spend Approval.

The launch seam is the **only** place all three paths converge, so it is the right — and only — place to make
task creation idempotent without adding a new authority or a new write path.

## Decision

A single pure module, `marketing/dedup.ts`, two pure pieces, both **DEFAULT-OFF and owner-workspace-first**
(mirroring `resolveDeliveryFlags`, #295). Turning the master flag on without naming `ownerWorkspaceId` dedups
for **nobody** — the safest possible default.

### 1. Idempotent task creation (the root fix)

- `normalizeObjective(text)` — strip a leading structural `@handle` prefix, lowercase, NFKC, collapse
  whitespace, strip surrounding quotes and trailing sentence punctuation. A **comparison key only**.
- `findDuplicateOpenTask({ department, objective, openTasks })` — returns an existing OPEN task with the same
  normalized objective **in the same department**, or null. Same words briefed to two departments are two
  real jobs, not a duplicate.
- Wired into `MarketingMentionService` as an **optional** `dedupe` gate (same shape as the #68 auth gate and
  the #246 model gate): when present AND `isEnabled(workspaceId)`, the open tasks are read once up front and a
  re-briefed objective is **skipped** — no `invoke`, no admission slot, no `marketing_tasks` row, no
  downstream draft. The skip is reported in a new `deduped[]` result array (so the composer can say "the fleet
  is already on it"). The in-memory open-task list grows as launches record tasks, so two personas on one
  message can't open two copies of one objective. Absent gate ⇒ today's behavior, every existing test
  unchanged.

### 2. Collapse duplicate Spend-Approval drafts (the historical pile)

- `collapseDuplicateDeliverables(approvals)` — for `agent.deliverable` cards only, collapse those sharing the
  same requesting agent (the department proxy) **and** the same normalized objective to the first occurrence
  (input order preserved ⇒ oldest-first list keeps the oldest). Non-deliverable approvals (money / other
  action types) and deliverables with no objective **always** pass through untouched.
- Applied in `GET /workspaces/:wid/approvals` for the **pending** queue only, and only when dedup is enabled
  for the workspace — so the board and the review queue show one card per real objective without masking any
  governance record on any other status.

### Where each piece lives

- **`marketing/dedup.ts` (pure):** `normalizeObjective`, `resolveDedupeEnabled`, `findDuplicateOpenTask`,
  `collapseDuplicateDeliverables` — no IO, fully unit-tested.
- **`marketing/mention.ts`:** the optional `MarketingDedupeGate` dep + `DedupedMention` result; the skip
  branch before `invoke`.
- **`marketing/default.ts`:** the production gate — `isEnabled` from `resolveDedupeEnabled(loadConfig().marketing)`,
  `openTasks` from `listMarketingTasks` filtered to `status === "launched"`.
- **`config/schema.ts`:** two new optional knobs on the (replace-merged) `marketing` block — `dedupeTasks`
  (master, default OFF) and `dedupeOwnerWorkspaceOnly` (default true). No `layers.ts` change (replace-merge).
- **`routes/approvals.ts`:** the pending-queue collapse.

## Consequences

- **No migration, no new table, no new authority.** Pure reuse of the existing `marketing_tasks` records and
  the #13 approvals read. Zero sibling-workspace migration-collision risk; colocation stays green (no governed
  table touched).
- **Default-OFF, owner-first preserved.** With the flag off the launch seam behaves exactly as before and the
  approvals list is returned verbatim — every existing unit/integration/web test is unchanged.
- **Injection defense (premortem #200 §6).** The objective is owner/agent-authored DATA. `normalizeObjective`
  only normalizes for **structural string comparison**; it never parses the text for instructions and never
  feeds it to a tool. A duplicate is decided on equality of normalized strings scoped by department.
- **Production-grounded (premortem #200).** Dedup reads the real `marketing_tasks` open-task set — it never
  fabricates "already running"; if no open task exists, the brief launches for real.
- **Honest reuse, not suppression.** A deduped brief returns the existing task id (the work the owner can
  watch), and the draft collapse hides only EXACT-objective duplicates from the same agent on the pending
  queue — never across departments, never on other statuses, never non-deliverable governance records.
