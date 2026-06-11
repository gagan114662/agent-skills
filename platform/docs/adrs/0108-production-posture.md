# ADR-0108: Production Posture — uptime monitoring, DR-target proof, and a cost-ceiling runbook

- **Status:** Accepted (shipped in PR for #108)
- **Date:** 2026-06-11
- **Context issue:** [#108](https://github.com/gagan114662/agent-skills/issues/108)
- **Spec:** [docs/specs/108-production-posture.md](../specs/108-production-posture.md)
- **Builds on:** [ADR-0019](0019-deploy-observability.md) (probes + `/readyz`, the operations runbook),
  [ADR-0038](0038-cloud-default-posture.md) (dev/prod profiles, the preflight launch gate),
  [ADR-0099](0099-disaster-recovery.md) (off-site backups, the restore runbook, the maintenance flag),
  [ADR-0113](0113-performance-capacity-rails.md) (`infraBudgetStatus` — the infra budget-ceiling signal),
  [ADR-0117](0117-self-healing-flywheel.md) (the `GitHubIssueProvider.createIssue`/`reopenIssue` path
  this monitor reuses), [ADR-0050](0050-founder-console.md) (the issue/notification surface alerts land in).

> **Numbering note.** Spec/ADR use the `0108` slot (the issue number), per the project's by-issue
> numbering convention (see ADR-0099's note) — chosen to dodge sibling-workspace collisions in the
> shared sequence. **This slice ships no migration** — the uptime monitor deliberately stores its only
> state (the "currently alerting" flag) *as an open GitHub issue*, and the cost/DR work is documentation.

## Context

The bulk of #108 is **already live**: the API runs always-on on Fly (`reload-api`, `/readyz` gate,
migrate-on-deploy), Postgres is Fly-managed, Redis is Upstash, the web console serves on `ipop.ai` from
a Vercel project, dev/prod posture is the #69 profile system, off-site backups + a restore drill run on
schedule (#99), and the infra budget-ceiling *signal* exists in code (#113). The audit table in the
spec maps every original scope item to where it shipped.

Three gaps survive that audit, and they share a theme: **the platform can't yet tell a human when it's
actually down, can't prove its backups point at the live DB, and has no operator playbook bounding the
hosting bill.** A 24/7 company that can't page itself is not 24/7.

The hard parts are not "curl a URL." They are: (a) an alerter that **dedupes** — one issue per outage,
not one every 5 minutes — and **auto-recovers** without a human closing stale issues; (b) a monitor
with **no new database** (it must not itself be a thing that can go down with Postgres); (c) reusing the
existing GitHub plumbing rather than a second issue client; and (d) doing the DR/cost work as
**documentation that names the live target**, not redundant code.

## Decisions

1. **Uptime monitoring is a scheduled GitHub Actions workflow, not an in-app cron or a paid APM.** It
   must run on infrastructure *other than ours* — the whole point is to notice when our box is down, so
   it cannot live on our box. GitHub Actions is free, already trusted with our secrets, and its
   `schedule` trigger + `workflow_dispatch` give a 5-minute heartbeat plus a manual probe. A paid
   Pingdom/Better-Uptime would add a vendor + a bill for what the brief explicitly scopes as "external
   check or scheduled workflow that opens a GitHub issue on failure."

2. **GitHub Issues are the alert state AND the notification.** Instead of a `uptime_incidents` table,
   the *open issue itself* is the "currently alerting" flag. This is why the slice needs **no
   migration**: the dedupe state lives where the alert lives. Issues already fan out to the owner's
   notifications and the #104 Founder Console issue feed, so opening one *is* paging. Recovery closes
   it, leaving a clean audit trail (every outage = one issue, opened-at → closed-at = the duration).

3. **The judgment is a pure core; the workflow only does IO.** Mirroring #17/#96/#105/#113,
   `evaluateResponse` (health verdict) and `decideAlertAction` (the open/recover/noop dedupe brain)
   are pure functions unit-tested for every branch with no network and no GitHub. `check-cli.ts` only
   fetches the URLs and applies the decided effect via the issue provider. Dedupe is keyed on a
   **stable hidden marker** (`<!-- uptime-monitor:<id> -->`) in the issue body plus an `uptime-alert`
   label — robust to title edits and to a human renaming the issue.

4. **Fail-soft and self-guarding.** With no `GITHUB_TOKEN` (a fork, a local run), the CLI still probes
   and **exits non-zero if any target is down**, so the workflow goes red and is itself a signal — it
   simply skips the issue side-effects. A probe error is *down*, never a crash. The token is read from
   the Actions environment, passed as a bearer header by the existing provider, and never logged.

5. **Reuse `GitHubIssueProvider`, extend it minimally.** #57 gave it read+comment, #117 added
   `createIssue`/`reopenIssue`. This slice adds exactly two additive methods — `listOpenIssuesByLabel`
   (to find the current alert) and `closeIssue` (to recover) — so there is one GitHub client in the
   codebase, not two.

6. **DR-target + cost-ceiling are documentation, because the code already exists.** `dr-backup.yml`
   already dumps off-site; the gap is that nothing *says* `DR_DATABASE_URL` must be the Fly production
   DB. `infraBudgetStatus` already warns; the gap is no operator runbook tying it to the real bill and
   no record of the hard caps. We close both with named, cross-linked runbooks rather than new code —
   the cheapest correct fix, and the one a 2 a.m. operator actually needs.

## Consequences

- **Good:** the company can page itself; outages become one deduped, auto-recovering issue with a
  measurable duration; backups provably target the live DB; the hosting bill has a documented hard cap
  (one Fly machine), a soft warning (#113), and an external spend limit. No migration ⇒ zero
  sibling-workspace collision risk.
- **Cost:** the 5-minute schedule is GitHub-Actions-billed minutes (negligible — two `curl`s). A
  GitHub-wide outage blinds the monitor, but that is the same surface our code already lives on.
- **Deferred:** richer alerting (latency SLOs, multi-region probes, status page) is left to the #112
  SRE loop / a future status-page slice; this is the heartbeat, not full APM.
