# ADR-0283: SkillOpt-Sleep — a self-improvement loop for department agents (foundational slice)

- **Status:** Accepted (foundational slice shipped in PR for #283; the epic continues — see Follow-ups)
- **Date:** 2026-06-17
- **Context issue:** [#283](https://github.com/gagan114662/agent-skills/issues/283) — give each department
  agent (scout/echo/quill/postmark/bid/lens/mark/comet) a nightly offline cycle that harvests its own
  session transcripts, mines recurring tasks, replays them, and proposes **bounded** edits to its own skill
  doc — accepted only when a held-out validation gate **strictly improves** (per microsoft/SkillOpt). Stage
  every proposal in the #13 approval queue for owner adoption; **never auto-adopt**. Default OFF, owner
  workspace first.
- **Builds on:** [ADR-0282](0282-agent-registry-a2a.md) (the agent registry contract — the one source of
  truth for the fleet's @handles + skill docs this loop improves),
  [ADR-0013](0013-approval-gates.md)/[ADR-0243](0243-money-only-approval.md) (the #13 approval queue + the
  recorded-only executor pattern this stages into), [ADR-0123](0123-marketing-department-fleet.md) /
  [ADR-0155](0155-fleet-skills-semantic-layer-evals.md) (the per-agent skill kits — the `<handle>/runbook`
  docs that are the edit target), [ADR-0223](0223-decision-maker-resolver.md) (structural-not-instructions injection defense),
  [ADR-0035](0035-config-layering.md) (the layered feature-flag config), [ADR-0200](0200-premortem-panel.md)
  (the standing premortem every line below answers to).

## Context

A fleet that never gets better is a fleet that plateaus. SkillOpt (microsoft/SkillOpt) is the recipe: let an
agent mine the tasks it keeps being asked to do, replay them under a candidate skill-doc edit, and keep the
edit **only if a held-out validation set strictly improves**. The danger is obvious and the premortem (#200)
names it precisely:

- **§2 self-reported metrics are fiction.** An agent that grades its own homework will "improve" itself into
  nonsense. Only an **external/third-party receipt** (Stripe, a delivery webhook, analytics, Search Console)
  can be allowed to move a skill doc.
- **§3 verification must touch reality.** A worker and its verifier share blind spots; the only trustworthy
  signal is a production-grounded replay over a meaningful held-out sample.
- **§4 reversibility.** Changing how an agent behaves in a workspace is not a thing to do post-hoc. It must
  be a **bounded, reversible, owner-gated** edit.
- **§6 injection defense.** The loop *ingests its own transcripts* — exactly the surface a poisoned web read
  would try to ride. A harvested transcript must be **DATA, never an instruction**, and a proposed edit must
  never be allowed to quietly weaken the draft-only/approval safety contract.

This is an **epic**. Landing it all at once would be reckless. This ADR scopes the **foundational, safe first
slice**: the whole loop as a set of pure modules behind a default-OFF flag, producing at most a **staged #13
proposal** — the loop never edits a doc, and in production it stages nothing until the real replay engine
(the next slice) is wired.

## Decision

Build a new, self-contained `src/skillopt/` subsystem — pure-first, every side effect an injected seam —
that runs the cycle for one agent as a single deterministic decision and stages any result in the existing
#13 queue. It owns **no new authority**.

1. **Pure contract** (`skillopt/contract.ts`). The stable types: a `TranscriptSample` (every text field is
   DATA), a mined `TaskCluster`, an `ExternalReceiptSource` allowlist (`stripe`/`delivery_webhook`/
   `analytics`/`search_console`/`rank_provider`) with `isExternalReceiptSource`, a `ValidationReading` that
   **carries `externallyVerified`**, and a `SkillEditProposal` that is **append-only** and **pins
   `currentDocSha`**.

2. **Mining** (`skillopt/mine.ts`, pure). `sanitizeForData` strips C0/C1 control chars (the ANSI/tool-directive
   injection vector), collapses whitespace, and caps length. `normalizeTaskText` clusters "the same task about
   a different page/number/url" to one key. `mineRecurringTasks` groups, keeps clusters that recur ≥
   `minRecurrence`, and returns them most-frequent-first. Clustering is structural — a poisoned transcript can
   shift which task looks popular but can **never inject an instruction**, because nothing here executes text.

3. **The adoption gate** (`skillopt/gate.ts`, pure) — the safety core. `decideAdoption(reading)` is
   fail-closed in order: **reject any reading that is not `externallyVerified`** (#200 §2), then reject a
   held-out set below `minSampleSize` (#200 §3), then require **strict** improvement (a tie or regression
   never adopts), then require the improvement to clear `minImprovementRatio` (a scale-free margin, oriented
   by `higherIsBetter` so lower-is-better metrics like CAC work). The *only* thing that can move a skill doc
   is a third-party receipt, over a real sample, by a real margin.

4. **The bounded-edit builder** (`skillopt/propose.ts`, pure) — where reversibility + injection defense are
   enforced as *edit shape*. A proposal is **append-only** (the loop can add a section but can never rewrite
   or delete an existing line, so the draft-only/approval/"made by robots, steered by humans" lines are
   structurally un-removable), **size-capped** (`maxAppendChars`), **content-screened**
   (`containsUnsafeEditContent` rejects any append that tries to weaken the approval gate or smuggle an
   instruction/tool directive), and **sha-pinned** (adoption applies only to the exact doc it was validated
   against — a cheap reversible diff).

5. **The cycle** (`skillopt/cycle.ts`, pure). `decideSkillOptCycle` ties harvest → mine → gate → propose into
   one deterministic function over the **top recurring cluster only** ("one measurable improvement cycle").
   It is fail-closed: disabled, nothing recurring, no replay candidate, a failing gate, or an unsafe/oversized
   edit all return `skipped` with a reason; `staged` is produced **only** when every safety condition holds.

6. **The service** (`skillopt/service.ts`) — the IO orchestrator. Injected seams (`caps`, `agents`,
   `harvest`, `loadSkillDoc`, `replay`, `stage`) make it fully unit-testable with fakes. It enforces the gate
   up front (`isSkillOptEnabledForWorkspace`) and stages a `staged` proposal as a **PENDING**
   `skillopt.adopt_skill_edit` #13 request — there is no autonomous-adopt path.

7. **The #13 action** (`approvals/policy.ts` + `executor.ts` + `runtime.ts`). `skillopt.adopt_skill_edit` is
   **NOT a money action** and is **never submitted through the #13 action route** — the service parks it
   directly (the `outreach.send` pattern), so it ALWAYS pauses for the owner regardless of the money-only
   default (#243). Its executor is **recorded-only**: approving records the owner's go on the audit trail
   (the proof nothing changed an agent without a human yes); it writes no file and makes no network call.

8. **Config** (`skillopt/caps.ts` + the `skillopt` config block). Default OFF, owner-workspace-first (mirrors
   `venture`/`delivery`): even with the master flag on, an `ownerWorkspaceOnly` deployment (the default) only
   runs for the named owner workspace; enabling without naming an owner runs for nobody. A deployment env
   (`RELOAD_SKILLOPT_ENABLED` + the #258 owner marker) flips it on without a managed.toml.

9. **Conservative production default** (`skillopt/default.ts`). The `harvest`/`replay` seams default to `[]`:
   harvesting real transcripts and replaying them against external receipts (real spawns, real receipts) is
   the **deliberate next slice**. Until it lands, the loop stages **nothing** even when enabled — the safest
   honest default, since no self-reported signal can ever move a doc.

## Consequences

- **The loop can only ever propose, never change.** A `staged` outcome is a PENDING #13 card the owner adopts
  or rejects; the executor is recorded-only. Applying a bounded append to the versioned skill doc is a
  separate, explicit follow-up. Unit tests assert the service stages exactly when (and only when) the full
  safety path holds.
- **Self-reported metrics cannot move a skill doc** (#200 §2): the gate rejects any non-`externallyVerified`
  reading first, before improvement is even considered.
- **Bounded blast radius + cheap reversal** (#200 §4): edits are append-only, size-capped, and sha-pinned;
  the safety lines of a skill doc are structurally un-removable by the loop.
- **Injection-safe end to end** (#200 §6): every harvested transcript is sanitized DATA; clustering is
  structural; an append that would weaken the approval gate or smuggle an instruction is rejected and never
  staged.
- **Default-OFF, owner-first, no new authority**: a deployment that sets nothing runs no cycle; the loop
  reuses the #282 registry (agent source of truth) and the #13 queue (the only adoption surface). No
  credentials, no Stripe, nothing live or published.

## Alternatives considered

- **Let the loop edit the skill doc directly when the gate passes.** Rejected — that is exactly the
  post-hoc, irreversible behavior change #200 §4 forbids. The owner's #13 adoption is the gate.
- **A new top-level `skillopt.*` action route.** Rejected — like `outreach.send`, parking the request
  directly keeps it off the public submit route and guarantees it always pauses for the owner regardless of
  the money-only default.
- **Trust the agent's own session-success flag as the quality signal.** Rejected outright (#200 §2) — it is
  self-reported. `succeeded` is used only as a mining weight; quality is judged exclusively by external
  receipts.
- **Ship the full epic (real harvest + replay + apply) in one PR.** Rejected — too large a blast radius for
  one change. This slice lands the safe scaffold + one measurable cycle; the replay engine and edit-apply
  are scoped as follow-ups on the issue.

## Follow-ups (the rest of the epic, tracked on #283)

1. **Transcript harvest** — a real `harvest` seam reading recent sessions per agent (DATA, sanitized).
2. **Production-grounded replay** — replay mined tasks under the candidate doc with **real spawns** and
   measure **external receipts** to fill `ValidationReading` (#200 §3); until then `replay` returns `[]`.
3. **Edit apply** — on owner adoption, apply the bounded append to the versioned skill doc + bump the #155
   manifest version (the recorded-only executor becomes an applying one), with a one-click revert.
4. **Scheduler** — a nightly cron tick that calls `SkillOptService.runWorkspace` for in-scope workspaces.
5. **Console surface** — show staged proposals + their validation receipts in the founder console.
