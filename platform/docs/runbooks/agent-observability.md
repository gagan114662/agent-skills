# Agent Observability Runbook

Issue: #1292

Use this when the Founder Console Agent observability pane is not fully green.

## Signals

- Scheduler status: healthy, degraded, stopped, or unknown.
- Queue depth: waiting agent runs.
- Running and stalled runs: active work versus runs that need retry or owner attention.
- Failed runs in the last 24 hours and retry rate.
- Audit coverage: audited tool calls divided by total tool calls. Production target is 100%.
- Silent connector failures: connected accounts that stopped emitting healthy receipts.
- Recovery state: idle, retrying, needs_human, or unknown.

## Alert Policy

Page the owner/operator when any of these are true:

- Scheduler status is stopped.
- Stalled runs is greater than 0.
- Unaudited tool calls is greater than 0.
- Any connector is silently failing.
- Recovery state is needs_human.

Do not call the system production-ready when the observability stream is unknown. Unknown means the stream is unwired or unreachable, not healthy.

## Triage

1. Check the Founder Console Agent observability card.
2. If audit coverage is below 100%, stop new autonomous launches and inspect the missing tool-call events.
3. If a run is stalled, retry it only when the recovery state is retrying or the run is marked retryable.
4. If recovery state is needs_human, leave the run parked and escalate with the run id, workspace id, and last audited action.
5. If a connector is silent, refresh or reconnect that provider before allowing agents to depend on its data.
6. If scheduler status is stopped, keep outbound and publish actions halted until the scheduler emits a fresh healthy tick.

## Smoke Expectations

A production smoke should prove both paths:

- successful run: scheduler tick, run started, at least one audited tool call, run completed
- failed run: run started, audited failing tool call, failure classified, retry or needs_human recovery event emitted

Every observability event must carry workspace id, user id, run id, action id, provider/tool name, status, and timestamp.
