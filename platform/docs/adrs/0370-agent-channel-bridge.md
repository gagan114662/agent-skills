# ADR-0370: Agent→channel message bridge — route coordination lifecycle events into chat channels

- **Status:** Accepted (gated bridge + wiring; nothing enabled in production) (shipped in PR for #370)
- **Date:** 2026-06-18
- **Context issue:** [#370](https://github.com/gagan114662/agent-skills/issues/370) — the channels render
  the reload.chat layout (#354) and every panel reads real data, but the channels stay empty because **no
  agent ever posts a chat message**. This is the missing bridge from agent activity → channel messages.
- **Part of epic:** [#359](https://github.com/gagan114662/agent-skills/issues/359) — make the reload.chat
  vision real on ipop.ai (the owner watches real agents coordinate).
- **Builds on:** [ADR-0013](0013-approval-gates.md) (the #13 owner-approval queue — the only way to act on
  a money/irreversible proposal; this bridge only *surfaces* it), [ADR-0243](0243-money-only-approval.md)
  (the gate is money-only; the @mention adds no action path), [ADR-0282](0282-agent-registry-a2a.md) (the
  A2A handoffs this narrates), [ADR-0338](0338-durable-workflow.md) /
  [ADR-0282](0282-agent-registry-a2a.md) (the owner-first config shape this mirrors),
  [ADR-0352](0352-agent-coordination-surface.md) (the coordination UI this fills),
  [ADR-0200](0200-premortem-panel.md) (the standing premortem whose rails this answers to).

## Context

The coordination view re-mounted by #352 renders channels · messages · thread · members, and every panel
reads **real** server data. But `POST /channels/:cid/messages` is only ever called by humans (and the
owner's brief @mention): no code path routes agent-session output into `postMessage`. So even after the
backend coordination primitives (#361: A2A #282 / collaboration #319 / durable #338) are enabled, the
channels stay blank — it does not look like reload.chat, where a lead posts a plan, a teammate replies with
a status line, tasks appear inline, and a human is @mentioned only for an approval.

Agents are already first-class members (`kind="agent"`, named, colored). The missing piece is purely the
*narration*: turning coordination lifecycle events into channel messages authored as the acting agent.

## Decision

Add a small, pure-first **`src/agent-channel-bridge/`** module and wire it at the existing coordination
seams, entirely behind a **default-OFF, owner-workspace-first** flag.

- **`caps.ts`** — `resolveAgentChannelPostingCaps` + `isAgentChannelPostingEnabledForWorkspace`, mirroring
  `durable-workflow`/`agent-registry`: `enabled` defaults **false**, `ownerWorkspaceOnly` defaults **true**,
  and turning it on without naming `ownerWorkspaceId` posts for **nobody** (the safest default).
- **`events.ts`** — the typed `CoordinationEvent` union: `lead_plan`, `handoff`, `task_created`,
  `approval_required`. Free-text fields (`goal`/`task`/`title`/`summary`) are untrusted DATA; structural
  fields (channel, handles, ids) come from the blueprint / member rows / the approval record.
- **`compose.ts`** — PURE: turns an event into a text-only body. `sanitizeData` strips C0/C1 control chars,
  collapses whitespace, and hard-caps length (mirrors `a2a.ts#sanitizeTask`). The agent voice is fixed
  framing; only sanitized DATA is embedded.
- **`bridge.ts`** — the gated, **fail-closed, best-effort** dispatcher: gate → compose → resolve channel by
  name → resolve the ACTIVE agent member by @handle (guaranteeing `kind="agent"`) → `postMessage`. It
  **never throws** into its caller and no-ops on any miss, so it sits on top of audited paths the way
  `deliverPostedMessage` does.
- **`default.ts`** — real-repo wiring (`listChannels`, `getAgentMemberByHandle`,
  `getWorkspaceOwnerMemberId` + `getWorkspaceMember`, `postMessage`).

### Wiring (all gated, all best-effort, prod byte-for-byte unchanged)

| Acceptance bullet | Seam | Event |
|---|---|---|
| Lead posts plan on kickoff | `marketing/brief.ts` (optional `notifyKickoff` dep) | `lead_plan` |
| A2A handoff status line | `routes/a2a.ts` `message/send` | `handoff` |
| Inline task card (link → task id) | `routes/a2a.ts` `message/send` (after `createTask`) | `task_created` |
| @mention owner for a #13 approval | `routes/approvals.ts` pending branch (agent requester only) | `approval_required` |

Each call site is a few best-effort lines guarded by the bridge's self-gating. With the flag unset (the
production default), every call resolves to `{ posted: false, reason: "disabled" }` and writes nothing.

### Config

`agentChannelPostingSchema` + the `ResolvedConfig` field + default + layered `replace` (managed/owner layer
owns the block) in `schema.ts`/`layers.ts`. Env override
`RELOAD_AGENT_CHANNEL_POSTING_ENABLED` / `_OWNER_WORKSPACE_ID` (falling back to the shared
`RELOAD_MARKETING_OWNER_WORKSPACE_ID` owner marker, #258) in `loader.ts`.

## Rails (#200 / epic #359)

- **Default-OFF, owner-first, fail-closed** — named-nobody = nobody. An unconfigured deployment posts
  nothing; prod channels stay quiet.
- **No new money/irreversible action path** — the bridge performs no work. The `approval_required` post
  only *surfaces* the existing #13 gate (ADR-0013/0243); money/irreversible work still stops there.
- **Content is DATA, not instructions** — every embedded field is sanitized and rendered text-only
  (`MessagePane` already uses React text, no `dangerouslySetInnerHTML`). A `@mention` or `#13` inside a
  crafted goal/task is inert text, never a directive; it cannot widen scope.
- **Build + PR only; reversible** — unset the env and the bridge is dark again. No prod flag is flipped in
  this PR (flipping is the owner-gated operational follow-up under #361 / ADR-0352 §2).

## Alternatives considered

- **Post from inside the live agent harness/session loop.** Rejected: it couples narration to model output
  (and to #361 being enabled), and risks an agent's own text widening scope. Narrating structural lifecycle
  events keeps the agent voice fixed and the content inert.
- **A new realtime/event store for coordination chatter.** Rejected: `postMessage` is already the DB-backed
  source of truth the panels read; the bridge adds no store and no new authority.

## Consequences

- When the owner enables the flag for their workspace, one brief makes the channel show the lead's plan,
  A2A handoffs as status lines, inline task cards, and an @mention-for-approval — all real, no seeded
  messages — completing the visible-coordination half of the epic's DoD (#367).
- The four live call sites are ready for #361: as A2A/collaboration/durable are enabled, the handoff/task
  posts flow automatically (still gated by this flag).
- Customer tenants are untouched until `ownerWorkspaceOnly` is broadened.
