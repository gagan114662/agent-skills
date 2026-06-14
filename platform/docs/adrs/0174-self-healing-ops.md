# ADR-0174: Self-Healing Ops — ventures stay alive at 3am without the owner

- **Status:** Accepted (shipped in PR for #193)
- **Date:** 2026-06-13
- **Context issue:** [#193](https://github.com/gagan114662/agent-skills/issues/193)
- **Premortem it answers to:** [#200](https://github.com/gagan114662/agent-skills/issues/200)
- **Builds on:** [ADR-0112](0112-sre-loop.md) (the agent on-call loop: pure `decide` + IO `engine` +
  durable incidents + triage launch + #13 escalation — the closest analog), [ADR-0105](0105-fleet-watchdog.md)
  (the stuck-agent supervisor: kill + retry-N-then-escalate, already shipped — #193 reuses it, sets
  retry-once, and surfaces its escalations), [ADR-0148](0148-reliability-surface.md) (owner paging /
  war-room / deploy correlation at the SRE notifier seam), [ADR-0171](0171-self-qa-loop.md) (the
  two-reporter self-filing pattern: GitHub marker dedup + flywheel record), [ADR-0117](0117-self-healing-flywheel.md)
  (the failure-class ledger that feeds #172; #193 adds the `ops_incident` class), [ADR-0172](0172-self-shipping-loop.md)
  (the `agent-ok` issues the postmortem feeds), [ADR-0041](0041-deploy-to-live-url.md) (rollback to last
  green + scale-within-caps + health probe), [ADR-0084](0042-autonomy-real-sessions.md) (the #92 launcher
  every loop reuses), [ADR-0013](0013-approval-gates.md) (the destructive-action queue),
  [ADR-0050](0050-founder-console.md) (the read-only aggregate + attention reasons), [ADR-0173](0173-founder-briefings.md)
  (the daily brief), [ADR-0099](0099-disaster-recovery.md) (maintenance Redis flag + by-issue numbering).

> **Numbering note.** Migration uses the next-free `0175` slot; the ADR uses `0174` (the next free ADR
> number — ADR numbers and migration numbers are independent sequences). The flywheel `ops_incident`
> failure class is a **TS-only** enum value (the `failure_class` column is plain `text` with no DB
> CHECK), so no enum migration is needed — only the new `self_healing_remediations` table.

## Context

24/7 autonomy means nothing if an incident at 3am waits for the owner to wake up. The platform already
**detects** a great deal — the #112 SRE loop opens incidents off SLO breaches, the #105 watchdog kills
and retries stuck agents, the #108 uptime check probes ipop — but detection is not *self-healing*. What
was missing is a per-venture **remediation brain** that turns a detected incident into a **bounded,
reversibility-classed action** (restart / rollback / scale), dispatches a fix session with the runbook
in context, files its own postmortem when it can't, and turns the console fleet-health signal red with
the reason. That is #193.

The hard parts are not the primitives (rollback, scale, launch, the #13 queue all exist) but doing this
**without violating the #200 premortem**:

- **§3 — checks must touch reality.** A remediation that fires off a self-reported metric can act on a
  lie. The probe is a *real HTTP request to the live deployment URL* — `reachable: false` is a network
  failure that actually happened, never an absent reading. A signal with no real observation never breaches.
- **§4 — reversibility classes.** Restart is `reversible` (no lasting effect) and auto-runs. Rollback
  (changes what's live) and scale (spends money) are `cheap` but **destructive** — they stay
  `#13`-gated by default and only auto-run when the owner has *pre-committed* the bounded action. No
  action in the catalog is `irreversible`; the class exists in the type so a future one can never
  silently auto-run.
- **Bounded blast radius + fast detection + cheap reversal.** Scale clamps to the tenant cap; rollback
  targets the last green deploy; an auto action is retried **once** and then escalates to a human.

## Decision

A new `self-healing/` module, same pure/IO split as #112/#105:

- **`decide.ts` (pure, unit-tested):**
  - `decideHealth(probe, thresholds)` — per-venture `uptime` / `error_rate` / `queue_depth` /
    `stuck_agent` → the set of breached signals. Thresholds are config-gated (#193 AC1).
  - `decideRemediation(input)` — the brain. Fail-closed priority: kill switch → none; auto-remediation
    off → escalate; auto attempts exhausted → escalate; `stuck_agent` → escalate (the #105 watchdog
    owns it); `queue_depth` + scale allowed → `scale_up` (gated unless pre-committed); `uptime`/`error`
    + a correlated deploy + rollback allowed → `rollback` (gated unless pre-committed); else restart
    (reversible, auto); else escalate. Every action carries its reversibility class + whether it needs a
    #13 approval.
- **`runbook.ts` (pure):** the markdown bundle handed to a dispatched fix session — the breach, the
  action, the steps, and the rule that destructive steps must clear the #13 queue (#193 AC2).
- **`reporter.ts` (pure):** the #171 two-reporter self-filing — a rich GitHub postmortem (timeline +
  root cause + **the check that would have caught it**), deduped by a `<!-- self-healing:<sig> -->`
  marker and labelled `agent-ok` (so the #181/#172 self-shipping loop picks it up), plus an
  `ops_incident` flywheel record (#193 AC4). Fail-soft: one reporter throwing never drops the others.
- **`engine.ts` (IO):** a default-OFF periodic tick (maintenance → enabled → kill-switch gated) that
  probes each venture surface, decides, and dispatches: restart through the **same #92 launcher** every
  loop reuses (so it passes the same #71 admission); rollback/scale to the **#13 queue**; an escalated
  incident self-files a postmortem. Durable `self_healing_remediations` ledger (one open per
  `venture_key + signal`, partial-unique like `sre_incidents`) tracks `attempts` for retry-once.

**Surfacing:** the #104 founder-console `attention.reasons` gains an escalated-incident + stuck-agent
reason → the console **fleet-health dot goes red with the reason** (#193 AC3); the #173 daily brief
gains a one-line **incident summary** (open / auto-fixed / escalated + the worst venture) (#193 AC5).

**Default-OFF, owner-workspace-first.** `selfHealing.enabled` is off; `autoRemediate` is an independent
second switch (off ⇒ escalate-only, nothing acts); destructive actions are off and approval-gated until
the owner opts in / pre-commits. ipop opts in via the managed layer; `caps.test` stays off. The timer
(`SELF_HEALING_INTERVAL_MS`) defaults to 0.

## Consequences

- **Good:** a venture's live surface is now watched and bounded-remediated without the owner; every
  incident leaves a durable trace + a self-filed postmortem feeding the fix loop; the console honestly
  reflects fleet health. Reuses every existing authority (launcher, #13, deploy, watchdog, flywheel) —
  no new launch path, no new approval system.
- **Cost / honesty:** the default probe wires `uptime` as the production-grounded reading; `error_rate`
  and `queue_depth` are real **only when the venture's health endpoint reports them as JSON** (else
  null ⇒ no breach) — the thresholds + decision logic are fully implemented and tested, with a clear
  seam for a per-venture metrics source. Stuck agents remain the #105 watchdog's authority; the console
  reads its escalations rather than double-acting.
- **Duplicate-issue tradeoff:** the rich postmortem issue is the canonical one; the flywheel record is
  for recurrence/console. If an operator separately enables the #117 flywheel issue-filer, it dedups to
  one issue per fingerprint — the same accepted dynamic as every other flywheel-recording loop.

## Alternatives considered

- **Extend the #112 SRE engine in place.** Rejected: it would couple remediation into a heavily-tested
  detector and widen its blast radius. The new module *composes* with SRE (and could consume its
  incidents) without modifying it.
- **Auto-execute rollback/scale on approval.** Deferred: like #112 today, the engine *enqueues* the #13
  approval; acting on approval is a follow-up. Honors §4 (a human is in the loop for destructive acts).
- **Per-incident notification state machine for re-escalation.** Rejected for the same reason as #173 —
  the durable ledger's `status` + `attempts` already encode it without a fragile state machine.
