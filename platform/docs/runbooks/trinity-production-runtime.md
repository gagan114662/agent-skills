# Trinity Production Runtime Runbook (#1212)

This runbook is the production deployment path for running ipop agents on
[AbilityAI Trinity](https://github.com/Abilityai/trinity). It is intentionally written as a deployable
blocker-clearing plan, not a claim that production Trinity is already live.

Trinity's current README positions it as a self-hosted agent runtime with Docker-isolated agents,
fleet-wide scheduling, health monitoring, audit trails, MCP/CLI access, and PostgreSQL recommended for
production. ipop uses those primitives as the production home for scheduled, long-running, multi-agent,
or audited work.

## Current Production State

- **Status:** deployment runbook exists; production instance is not yet evidenced in this repo.
- **Named blocker:** no committed production Trinity endpoint, PostgreSQL `DATABASE_URL`, MCP key, or
  operator identity map has been provided yet.
- **Allowed interim path:** local/manual agent execution may continue only when receipts explicitly say
  Trinity was unavailable or the agent is not onboarded.
- **Closure evidence required:** a production receipt linking the Trinity instance, fleet health,
  audit coverage, uptime, recovery events, and per-agent onboard status.

## Target Topology

- **Runtime perimeter:** run Trinity inside the ipop-controlled network perimeter. The web UI, API docs,
  and MCP endpoint must be reachable only through approved operator access, not public unauthenticated
  ingress.
- **Database:** use PostgreSQL for production Trinity state. SQLite is allowed only for local development
  and evaluation.
- **Containers:** each production ipop agent runs as its own Trinity agent/container identity.
- **Credentials:** inject credentials per agent identity. Do not share one broad credential across the
  whole fleet. Payment, publishing, outbound, and customer-account credentials stay behind the existing
  ipop approval/connect flows.
- **MCP/API access:** configure Trinity MCP for operator and automation access. Store the MCP API key in
  the approved secret store and rotate it on operator offboarding.
- **Operators:** configure named users for the team. A single shared admin credential is not acceptable
  production access.
- **Schedules:** scheduled work uses Trinity schedules. Ad hoc local loops are allowed only for dev or
  incident fallback, and must say so in the receipt.
- **Receipts:** every production run that used Trinity must cite the Trinity agent id, execution or
  schedule id, audit reference, health/recovery status, and unaudited-tool-call count.

## Fleet Onboarding Matrix

| Agent | Trinity production identity | Default schedule | Initial onboard status |
| --- | --- | --- | --- |
| scout | `ipop-scout` | SEO + technical-site audit cadence | Ready once production Trinity endpoint, MCP key, and site-read credentials exist |
| echo | `ipop-echo` | Social listening + reply-draft cadence | Ready once social aggregator credentials and approval-queue link are mapped |
| quill | `ipop-quill` | Content refresh + landing-page draft cadence | Ready once hosted content workspace and approval-queue link are mapped |
| postmark | `ipop-postmark` | Email sequence draft + deliverability review cadence | Not yet onboardable for live send until customer ESP credentials and suppression sync are configured |
| bid | `ipop-bid` | Paid-channel draft + budget pacing cadence | Not yet onboardable for live spend until hard budget caps and spend receipts are mapped |
| lens | `ipop-lens` | Analytics insight + anomaly scan cadence | Ready once analytics providers and read-only warehouse/API credentials exist |
| mark | `ipop-mark` | Brand consistency + asset review cadence | Ready once asset storage and brand-kit read/write scope are mapped |
| comet | `ipop-comet` | Reach/prospecting draft cadence | Not yet onboardable for outbound until prospect-source credentials, suppression, and approval gates are mapped |

## Deployment Checklist

1. Stand up Trinity in the ipop-controlled environment.
2. Configure PostgreSQL with a production `DATABASE_URL`; record that SQLite is not in use.
3. Configure named operator accounts and remove shared-admin-only access.
4. Configure MCP/API access and store keys in the approved secret store.
5. Create one Trinity agent/container identity per onboardable ipop agent in the matrix.
6. Attach the minimum credentials each identity needs for its draft/read work.
7. Create schedules for recurring work; disable equivalent ad hoc local loops.
8. Run one forced-failure drill: stop or fail a non-customer-impacting agent and verify auto-recovery or
   visible escalation.
9. Export the production receipt: fleet health, uptime, unaudited tool calls, failed executions,
   recovery events, and schedule status.
10. Link the receipt from the issue/PR before marking #1212 done.

## Receipt Template

Agents and operators should use this shape whenever Trinity handled production work:

```md
## Trinity receipt

- Agent: <handle> / Trinity id <ipop-agent-id>
- Trigger: <manual | schedule id>
- Execution: <execution id or URL>
- Audit: <audit event id or URL>
- Health before/after: <healthy/degraded/recovered>
- Recovery events: <none | event ids>
- Uptime window: <window + percentage if available>
- Unaudited tool calls: <count, target 0>
- Fallbacks: <none | local/manual fallback reason>
- Operator: <named operator or automation identity>
```

## Failure Drill

Use a non-customer-impacting agent for the first drill, preferably `ipop-mark` or `ipop-lens`.

1. Start a scheduled execution.
2. Stop the agent container or force a controlled command failure.
3. Confirm Trinity records the failed execution in the audit trail.
4. Confirm auto-recovery restarts the agent or visibly escalates the failure.
5. Confirm the fleet health receipt shows the incident and recovery state.
6. Confirm the unaudited-tool-call count remains `0`.

## Done Criteria

#1212 can close only when the PR or linked issue comment includes one of:

- production Trinity is live with PostgreSQL, named operators, MCP/API access, per-agent identities,
  schedules, audit trail, and at least one recovery drill receipt; or
- a deployment PR/runbook names the remaining external infrastructure blocker and gives every agent an
  explicit onboard or not-yet-onboardable reason.
