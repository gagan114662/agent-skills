# ADR-0352: Wire up the agent-coordination surface — re-mount the orphaned reload.chat UI + the owner-first managed-layer enablement sequence

- **Status:** Accepted (slice 1 — the web surface + the documented enablement sequence; flipping the prod backend flags is owner-gated operational follow-up, NOT this PR)
- **Date:** 2026-06-18
- **Context issue:** [#352](https://github.com/gagan114662/agent-skills/issues/352) — a whole
  reload.chat-style coordination UI exists in the tree but is imported by nothing (dead code), while the
  backend coordination primitives ship flag-gated **OFF**; so the live product is the board only and agents
  can produce nothing but draft approval cards.
- **Builds on:** [ADR-0035](0035-config-layering.md) (the layered, owner-first feature flag),
  [ADR-0282](0282-agent-registry-a2a.md) (agent registry + A2A), [ADR-0319](0319-honest-session-disposition.md)
  (honest disposition + the flag-gated subagent-spawn / `agentCollaboration`),
  [ADR-0338](0338-durable-workflow.md) (the durable-workflow primitive),
  [ADR-0013](0013-approval-gates.md)/[ADR-0243](0243-money-only-approval.md) (the #13 approval gate),
  [ADR-0200](0200-premortem-panel.md) (the premortem this answers to),
  [ADR-0284](0284-agent-garden-console-surface.md) (the prior console-surface slice with the same
  owner-first + #13 discipline).
- **Precedent for structure:** the lavish-axi (#344) and no-mistakes ([ADR-0350](0350-no-mistakes-git-gate.md))
  adoptions — opt-in, default-OFF, owner-gated, documented, nothing auto-enabled.

## Context

The live web app renders only `ConsoleView` (`apps/web/src/components/console/ConsoleView.tsx`) —
`App.tsx → AuthGate → Workspace → ConsoleView` — the two-pane board (StandupPanel + Board + BriefComposer +
PeekDrawer + a settings/pricing overlay). A full coordination UI already exists alongside it but is imported
by **nothing except its own tests** (verified): `ChannelSidebar`, `MessagePane`, `ThreadPanel`,
`MembersRail`, `Composer`, `MessageQueue`, plus `MissionControlPanel`, `FounderDashboard`, `UsageDashboard`,
`AutomationsPanel`, `WorkflowsPanel`, `CatalogPanel`, `BriefingsPanel`, `AuditPanel`, `TemplatePicker`.
`Workspace.tsx` mounts only `ConsoleView`; the rest is dead code.

Meanwhile the backend coordination primitives are flag-gated **OFF**, owner-workspace-first (verified in
`apps/server/src/config/`):

| Primitive | Issue / ADR | Config block | `enabled` default | Owner-first default |
| --- | --- | --- | --- | --- |
| Agent registry + A2A | #282 / [ADR-0282](0282-agent-registry-a2a.md) | `agentRegistry` | `false` (calls OFF; discovery lists regardless) | `ownerWorkspaceOnly: true` |
| Subagent-spawn / collaboration | #319 / [ADR-0319](0319-honest-session-disposition.md) | `agentCollaboration` | `false` (drafts-only) | `ownerWorkspaceOnly: true` |
| Durable workflow | #338 / [ADR-0338](0338-durable-workflow.md) | `durableWorkflow` | `false` (legacy in-process poll) | `ownerWorkspaceOnly: true` |

Production `fly.toml` sets only `RELOAD_MARKETING_ENABLED`, `RELOAD_TRIAL_ENABLED`, `RELOAD_BILLING_ENABLED`
— every coordination knob is dark. So today agents can only emit draft approval cards: no coordination
surface, no delegation, no visible live action.

### Premortem (#200) obligations

- **§4 reversibility:** no live/irreversible action may run autonomously from the new surface — those stay on
  the #13 gate. The coordination view adds **no new action path**; it is read + steer (chat) only.
- **§6 untrusted content:** every channel / message / agent string is **DATA, not instructions** — rendered
  as React text, never `dangerouslySetInnerHTML` (there is none in these components), so agent-authored
  content can never become markup or widen scope.
- **Fail-closed:** the surface defaults OFF and shows for nobody unless a named owner workspace matches.

## Decision

### 1. Re-mount the orphaned coordination UI behind a NEW default-OFF, owner-workspace-first web flag

A pure gate, `apps/web/src/components/console/coordination-flag.ts`, mirrors the backend owner-first config
shape entirely on the web with **zero new backend**:

- `COORDINATION_UI_ENABLED` ← `VITE_RELOAD_COORDINATION_UI` (`true`/`1`); default **OFF**.
- `COORDINATION_OWNER_WORKSPACE_ID` ← `VITE_RELOAD_COORDINATION_OWNER_WORKSPACE_ID`; the owner-first marker.
- `shouldShowCoordination({ flagOn, ownerWorkspaceId, workspaceId })` — fail-closed at every branch: off flag
  ⇒ no; no current workspace ⇒ no; **no named owner ⇒ no** (naming nobody provisions it for nobody, exactly
  the `agentRegistry`/`agentCollaboration`/`durableWorkflow` default); otherwise show **only** when the
  current workspace IS the named owner.

`CoordinationView` re-mounts the existing components (`ChannelSidebar` · `MessagePane` · `ThreadPanel` ·
`MembersRail`, over a `MissionControlPanel` live strip). Each self-wires to the existing
`channels`/`messagesByChannel`/`directory` store and the **#147 mission-control seam** — no new fetch path.
`ConsoleView` shows a header chip and opens the view as a `ShellOverlay`, both guarded by the gate so a stale
open flag can never reveal it once off. With the prod env unset, prod is byte-for-byte the board it is today.

### 2. The owner-workspace-first managed-layer enablement SEQUENCE (documentation only — NOT flipped here)

When we choose to light up real coordination, enable the backend layers **in this order**, owner workspace
first, validating at each step before the next. This PR **flips none of these** — it is operational,
owner-gated work. The exact keys (server config block → env override):

1. **A2A (`agentRegistry`, #282)** — agents can call each other.
   - `agentRegistry.enabled = true` · env `RELOAD_AGENT_REGISTRY_ENABLED=true`
   - `agentRegistry.ownerWorkspaceId = <owner ws>` · env `RELOAD_AGENT_REGISTRY_OWNER_WORKSPACE_ID`
   - keep `agentRegistry.ownerWorkspaceOnly = true` (default); `maxCallDepth` bounds autonomy (#200 §5).
2. **Collaboration (`agentCollaboration`, #319)** — a lead may spawn a subagent to delegate.
   - `agentCollaboration.enabled = true` · `agentCollaboration.ownerWorkspaceId = <owner ws>`
   - keep `agentCollaboration.ownerWorkspaceOnly = true` (default). **No env override exists today** — this
     block is set via the config layer (profile/managed override), not an env var. Spawn is a model-spend
     amplifier, so it stays owner-first until proven.
3. **Durable (`durableWorkflow`, #338)** — long waits/retries route through the durable engine.
   - `durableWorkflow.enabled = true` · env `RELOAD_DURABLE_WORKFLOW_ENABLED=true`
   - `durableWorkflow.ownerWorkspaceId = <owner ws>` · env `RELOAD_DURABLE_WORKFLOW_OWNER_WORKSPACE_ID`
     (falls back to `RELOAD_MARKETING_OWNER_WORKSPACE_ID` when unset)
   - keep `durableWorkflow.ownerWorkspaceOnly = true` (default); `maxAttempts`/`backoff*`/`defaultTimeoutMs`
     bound retries.

Rationale for the order: discovery/A2A is the substrate collaboration delegates over; collaboration is what
generates the long-running multi-step work that durable execution then makes restart-safe. Enabling later
layers first would light up delegation with nothing to coordinate, or durable execution with no work to
durabilize.

### 3. Safety invariants (unchanged)

- All live/irreversible actions stay on the **#13 approval gate** ([ADR-0013](0013-approval-gates.md)/
  [ADR-0243](0243-money-only-approval.md)). The coordination view introduces no money/irreversible action.
- Agent/channel/message content is treated as **DATA** (React text; no raw HTML).
- Default-OFF, owner-workspace-first, fail-closed — both on the web (this PR) and the backend (the sequence).

## Consequences

- The dead reload.chat UI becomes a real, owner-only coordination surface that can be dogfooded before any
  broad rollout, with no backend change and no production flag flipped.
- **What this PR does NOT do:** it does not set `VITE_RELOAD_COORDINATION_UI` anywhere; it does not touch
  `fly.toml`; it does not enable `agentRegistry`/`agentCollaboration`/`durableWorkflow` in production; it adds
  no migration and no new money/irreversible action.
- Follow-up (owner-gated, operational): run the §2 sequence on the owner workspace, observe, then decide on
  broadening (`ownerWorkspaceOnly: false`) and on adding an env override for `agentCollaboration`.
