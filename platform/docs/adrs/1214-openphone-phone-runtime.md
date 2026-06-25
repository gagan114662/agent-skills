# ADR-1214: OpenPhone bridge for phone-native ipop agents

- **Status:** Proposed (exploration deliverable for issue #1214)
- **Date:** 2026-06-25
- **Context issue:** [#1214](https://github.com/gagan114662/agent-skills/issues/1214)
- **External reference:** [secondly-com/OpenPhone](https://github.com/secondly-com/OpenPhone)
- **Builds on:** [ADR-0013](0013-approval-gates.md) (human approval gates),
  [ADR-0014](0014-tasks.md) (event-sourced tasks), [ADR-0225](0225-outreach-engine.md)
  (owner-gated outreach), [ADR-0243](0243-money-only-approval.md) (money-only owner gate),
  [ADR-0337](0337-agent-action-contract.md) (agent action receipts),
  [ADR-0370](0370-agent-channel-bridge.md) (agent coordination narration), and
  [ADR-0464](0464-agent-execution-tools.md) (agent tool surface).

## Context

ipop is meant to behave like an autonomous marketing engine, but some high-value customer
signals live only on a founder's phone: missed calls, SMS threads, app notifications,
WhatsApp/LinkedIn/mobile-only workflows, calendar context, and commitments made while the
human is away from the web app. OpenPhone is a source-available AI-native Android OS preview
that exposes a privileged assistant, explicit capabilities, phone context, OS-mediated
actions, background jobs/watchers, approval surfaces, audit events, and trajectory exports.

The integration should make ipop agents phone-aware without pretending the web app owns a
phone. The right contract is a bridge: OpenPhone supplies phone context and reviewable device
actions; ipop supplies marketing intent, workspace task state, approvals, receipts, and
fleet orchestration.

## Decision

Create an **OpenPhone bridge service**, not an ipop fork inside the phone ROM and not a raw
mobile automation worker. The bridge is a narrow, owner-enabled runtime adapter between a
registered OpenPhone device and an ipop workspace:

1. **Phone events become ipop task triggers.** OpenPhone watcher/job outputs are normalized into
   ipop task events with source `openphone`, a stable `device_id`, a `phone_event_id`, an
   event kind (`missed_call`, `message_received`, `notification_received`, `calendar_changed`,
   `commitment_due`, `foreground_state_changed`), a redacted summary, and links to OpenPhone
   audit/trajectory evidence when present. The bridge creates or updates an ADR-0014 task; it
   does not send messages, place calls, or spend money.

2. **ipop requests device work as OpenPhone tasks/actions.** ipop can ask OpenPhone to draft,
   inspect, open, or prepare phone-native work by sending an OpenPhone `agent-task` compatible
   request (`goal`, `user_visible`, `background_allowed`, `capabilities`,
   `expires_in_seconds`). Low-risk actions may use capabilities such as `screen.read.visible`,
   `notifications.read`, `calendar.read`, `apps.launch`, or `tasks.observe`; medium/high-risk
   capabilities such as `messages.draft`, `messages.send`, `calls.place`, `clipboard.write`,
   `share.content`, `calendar.write`, `settings.write`, or `network.use` require explicit
   OpenPhone confirmation and/or ipop ADR-0013 approval before execution.

3. **Sensitive sends still stop at ipop approvals.** Any action that leaves the building
   (`messages.send`, `calls.place`, `share.content`, phone-mediated social/message sends, paid
   actions, purchases, or ad spend) must be represented as an ipop approval request first. The
   approval payload includes the exact recipient/channel/content or spend envelope. Only after a
   human approval can the bridge submit the matching OpenPhone `action-request` or release an
   already-pending OpenPhone confirmation. OpenPhone's local policy remains a second gate, not a
   replacement for ipop's approval queue.

4. **OpenPhone evidence becomes ipop receipts.** Every bridge action records OpenPhone
   `action-result`, `audit-event`, `audit-evidence`, and `trajectory-event` references on the
   ipop receipt. Receipts store the OpenPhone build/commit, device codename, device subject,
   model transport mode, action type, capability, pending action id, task id, trajectory export
   path/hash, audit export path/hash, and redaction mode. ipop never treats an unlinked phone
   action as completed marketing work.

5. **Trinity remains the fleet/server runtime.** Trinity (#1212) should schedule and recover
   ipop/server-side agents, track multi-user audit trails, and surface fleet health. OpenPhone
   supplies mobile context, phone-local watchers, OS-mediated action execution, and mobile user
   review. A Trinity run may create an OpenPhone bridge task; the bridge receipt links back to
   the Trinity run id and ipop task id.

## Required Contract Map

| OpenPhone contract | ipop mapping | Notes |
|---|---|---|
| `schemas/agent-job.schema.json` (`agent_turn`, `system_event`, `heartbeat`) | phone watcher/job source for ipop task triggers | Use for proactive phone events; do not map directly to sends. |
| `schemas/agent-task.schema.json` | ipop -> OpenPhone task request | ipop fills `goal`, requested capabilities, expiration, and whether background work is allowed. |
| `schemas/screen-context.schema.json` | evidence payload attached to task context | Store redacted summaries and risk flags; raw visible text is sensitive and should not be broadcast into chat. |
| `schemas/action-request.schema.json` | post-approval device action request | Supports OS-mediated `tap`, `type_text`, `open_app`, `open_url`, `notification_action`, `copy`, `paste`, and `share`. |
| `schemas/action-result.schema.json` | ipop action receipt input | Required for state, capability, source, detail, task id, and pending action id. |
| `schemas/audit-event.schema.json` | receipt event trail | Preserve `capability_evaluated`, `action_confirmed`, `action_executed`, and rejection events. |
| `schemas/audit-evidence.schema.json` | receipt evidence bundle | Required before claiming a phone action was executed. |
| `schemas/trajectory-event.schema.json` | replay/debug evidence | Link the trajectory path/hash for every evaluated device workflow. |

## ipop Service Map

| ipop surface | Bridge responsibility |
|---|---|
| `tasks` / ADR-0014 lifecycle | Create/update tasks from phone events; append `openphone.event_received`, `openphone.task_requested`, `openphone.receipt_attached`, and `openphone.blocked` events. |
| `approval_requests` / ADR-0013 | Park exact sensitive phone sends/spend as approvals; reject self-approval; keep OpenPhone confirmation as an extra local gate. |
| `outreach` / ADR-0225 | Let outreach compose a phone-native draft, but only queue a send approval; no autonomous SMS/call/social send path. |
| `agent actions` / ADR-0337 and ADR-0464 | Add an `openphone.device_action` tool result shape with device id, capability, action type, result state, audit refs, and trajectory refs. |
| `agent-channel-bridge` / ADR-0370 | Narrate structural phone task events into the workspace only after redaction; never post raw screen/message bodies. |
| observability / ADR-0019 | Correlate every bridge request with ipop request id, device id, OpenPhone task id, and trajectory/audit hashes. |

## Candidate E2E Workflow

**Missed customer call -> ipop drafts follow-up -> user approves -> OpenPhone sends via OS-mediated action**

1. OpenPhone watcher observes a missed call from a known or enriched contact and emits a
   `system_event`/watcher result with `phone_event_id`, caller identity, timestamp, and redacted
   call metadata.
2. The bridge creates an ipop task: `Follow up on missed customer call`, with source `openphone`,
   event kind `missed_call`, contact reference, and OpenPhone audit/trajectory links if available.
3. ipop's marketing/support agent drafts a follow-up SMS or app-native message and records the
   draft on the task.
4. The agent submits an ADR-0013 approval request for `external.send` or `outreach.send`, including
   exact recipient, channel, body, evidence, and phone capability `messages.send`.
5. A human approves in ipop. The bridge submits the corresponding OpenPhone task/action request.
6. OpenPhone still applies local policy. If the device requires confirmation, the user confirms on
   the phone; otherwise the OS-mediated action executes under granted policy.
7. The bridge writes an ipop receipt with `action-result`, audit events, audit evidence export,
   trajectory reference/hash, build/commit, device codename, and final state.
8. The ipop task transitions to done only when the receipt has execution evidence. If OpenPhone
   rejects, times out, or lacks proof, the task remains blocked with a concrete reason.

## Rejected Alternatives

- **Run all ipop agents inside OpenPhone.** Rejected: ipop's workspace, billing, approvals, task
  graph, outreach experiments, fleet scheduling, and multi-user audit model live server-side. Moving
  them into a phone ROM would fragment the product and make web/fleet agents hostage to device
  builds.
- **Use OpenPhone as a blind remote-control executor.** Rejected: raw taps/text would bypass the
  explicit capability/policy model and lose auditability. ipop should request semantic tasks/actions
  and require OpenPhone evidence back.
- **Treat OpenPhone local confirmation as enough for marketing sends.** Rejected: ipop's owner
  approval queue carries the workspace/business decision and exact message/spend review. OpenPhone
  confirmation proves device/user consent, not business authorization.
- **Claim production phone automation now.** Rejected: OpenPhone is a developer preview, Pixel 9a is
  the first physical target, generic ARM64 builds are not supported phones, and commercial use needs
  a separate written license.

## Blockers Before Production

- **Commercial license:** OpenPhone-owned materials are under PolyForm Noncommercial 1.0.0; ipop
  production/commercial use requires a written license from Dafdef, inc. or a separately licensed
  integration boundary.
- **Supported device proof:** first physical target is Pixel 9a (`tegu`). ipop cannot claim production
  device support until a real Pixel 9a or supported emulator/device run proves the bridge workflow.
- **GMS/vendor constraints:** OpenPhone does not redistribute Google apps, Google Mobile Services,
  vendor blobs, firmware, signing keys, or restricted material; any phone workflow depending on
  Messages/WhatsApp/LinkedIn/Google account surfaces needs environment-specific validation.
- **Evidence storage:** ipop needs a redaction and retention policy for phone screen text,
  notifications, call metadata, screenshots, and trajectory exports before broad rollout.
- **Device identity:** production needs device enrollment, session-token rotation, revocation, and
  per-workspace device ownership checks so one tenant cannot trigger another tenant's phone.

## Validation Plan

No production claim is allowed until all of the following are true:

1. A registered OpenPhone device or supported emulator can create a phone event and the bridge can
   create an ipop task with a linked `phone_event_id`.
2. The missed-call workflow above completes with a real OpenPhone audit evidence export and
   trajectory reference.
3. A negative test proves an ipop agent cannot submit `messages.send`, `calls.place`, paid actions,
   or externally visible shares without ADR-0013 approval.
4. A negative test proves OpenPhone rejection or missing evidence leaves the ipop task blocked rather
   than marked done.
5. The receipt stores OpenPhone build/commit, device codename, action result, audit reference,
   trajectory reference, and redaction mode.
