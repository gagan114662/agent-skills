# ADR-0282: Agent registry + A2A-style contract for the department fleet

- **Status:** Accepted (shipped in PR for #282)
- **Date:** 2026-06-16
- **Context issue:** [#282](https://github.com/gagan114662/agent-skills/issues/282) — make
  scout/echo/quill/postmark/bid/lens/mark first-class, discoverable, composable agents instead of
  bespoke tile-wired server code: a common contract (declared inputs/outputs, tools, capabilities, cost,
  risk-tier) plus a registry that lists/enables agents per workspace and lets agents call each other
  (A2A-style), with the call path observable.
- **Builds on:** [ADR-0123](0123-marketing-department-fleet.md) (the marketing blueprint — the single
  source of truth for the named agents, their channels, prompts and draft-only tool ceiling — and the
  `@mention → MarketingMentionService → SubagentService → venture-gated launcher` launch chain this
  reuses), [ADR-0012](0012-acp-a2a.md) (the EXTERNAL A2A/ACP protocol adapters — whose "derive the
  capability handshake, don't store it" and "compose the existing model, no new authority" decisions this
  follows for the internal fleet), [ADR-0013](0013-approval-gates.md)/[ADR-0243](0243-money-only-approval.md)
  (the money-only #13 gate), [ADR-0223](0223-decision-maker-resolver.md) (the structural-not-instructions
  injection-quarantine pattern), [ADR-0035](0035-config-layering.md) (the layered feature-flag config),
  [ADR-0200](0200-premortem-panel.md) (the standing premortem this answers to).

## Context

The department agents (scout/echo/quill/postmark/bid/lens/mark, and #280's comet) were real (seeded
personas, @-mentionable, audited launches) but they were
not **described**: nothing declared what each one is *for*, what it takes in and produces, how risky its
output is, or what it costs — and nothing let one agent hand work to another through a typed, governed,
observable seam. That blocks the Agent Garden console surface and the SkillOpt-Sleep self-improvement loop,
both of which need a machine-readable fleet contract and a composition primitive.

ADR-0012 already speaks A2A/ACP on the **wire**, for cross-org agents in any framework, over `/a2a/...`
(JSON-RPC). #282 is **distinct**: an *internal*, in-process contract + registry for our own department
fleet. We reuse the A2A *vocabulary* (an agent card / contract, a call, a target capability) but the
transport is the existing internal launch seam, not JSON-RPC — there is no second network surface and no
second auth/tenancy model.

The standing premortem (#200) sets the rails: any metric must be externally verified, verification must be
production-grounded, irreversible/risky actions must be pre-committed and human-gated, and agent-to-agent
calls must be injection-defended.

## Decision

Add a `agent-registry/` module that is **pure-first and derived, not stored** — mirroring ADR-0012's
"the descriptor is a pure function of the registry, computed on read." It adds **no table and no
migration**, so there is zero sibling-workspace migration-collision risk and the colocation gate stays
trivially green (no governed metric surface is touched).

### 1. The agent contract is derived from the blueprint (one source of truth)

`contract.ts` (pure) defines `AgentContract` — `{ handle, displayName, department, title, summary,
capabilities[], inputs[], outputs[], tools[], costTier, riskTier, gatedActions[] }` — and
`buildAgentContract(department)` derives it by merging the existing `MARKETING_DEPARTMENTS` blueprint
(handle/name/department/title/tools/intro) with a per-department **metadata table** (capabilities, typed
IO, cost tier, risk tier). A unit test asserts the metadata table covers every blueprint department (the
anti-drift latch, the same discipline the skill-colocation gate enforces), and that every external-send
department is `riskTier: "external_send"` and surfaces `external.send` as a downstream gated action.

`riskTier ∈ {read_only, internal_draft, external_send}` classifies the blast radius of an agent's
*output* (no agent can send/spend — every one carries only the blueprint draft tools). `gatedActions`
lists the #13 action types an agent's output can eventually trigger — **observability metadata, never
authority**: nothing there is reachable without the human #13 queue (ADR-0013/#243).

### 2. The registry is a pure projection of `personas × blueprint × caps`

`registry.ts` (pure) `buildAgentRegistry({ presentHandles, registryEnabled, isOwnerWorkspace,
ownerWorkspaceOnly })` returns one `RegistryEntry { contract, present, enabled }` per fleet agent.
`present` = the persona is seeded in the workspace (mirrors `marketing/roster.ts`); `enabled` = the
feature flag is on AND the agent is present AND the owner-first restriction is satisfied. With the flag
off, the catalog still **lists** (read-only) but every entry is `enabled: false`.

### 3. A2A calls are governed by one pure decision and dispatched down the existing launch seam

`a2a.ts` (pure) `decideA2ACall(input, registry)` is the heart and the single place a call is governed. It
returns an observable `A2ACallRecord` for the hop whether allowed **or denied** (a refused call is never
invisible). The checks, in order: structural identity (caller/target handle + capability validated against
charset/token regexes — never free text), registry membership (caller is a known fleet agent, target is
**enabled**), capability (the target must advertise it — no forged capabilities), content (the task is
sanitized; non-empty required), and bounds (a depth cap + a cycle guard).

`service.ts` orchestrates with injected seams (caps, present handles, dispatch, optional observe). An
allowed call's `dispatch` reuses the **#235 brief front door verbatim** (`createMarketingBriefService`):
it posts `@<target> <task>` and launches the target down the audited path (#68 auth → #59 SubagentService
→ #96 venture gate → #71 admission). **No new launch authority and no new execution path** — exactly
ADR-0012's "an A2A handoff becomes a task assigned to the receiving agent."

### How #282 answers the premortem (#200)

- **FM#6 injection.** The call's `task` is untrusted **DATA**: sanitized (control chars stripped,
  whitespace collapsed, length-capped) and handed to the target as its task string. It can never widen
  the target's tool/skill scope, name a tool, or change the requested capability — the caller, target and
  capability are structural and validated against the registry, so nothing in the body can promote a call
  the registry didn't already allow. This is the ADR-0223 quarantine pattern: the defense is
  architectural (the body never reaches an action), with sanitation as defense-in-depth. The caller
  attribution the dispatch prepends is built from the already-validated `@handle`, never from free text.
- **FM#5 bounded owner attention.** A hard `maxCallDepth` cap (default 3, a caps knob) plus a cycle guard
  stop an A2A loop from fanning out without the owner. Because the post-time @mention fan-out is
  human-author-only (ADR-0123), an agent's handoff never *auto*-triggers another launch — the registry is
  the only path, and it is bounded.
- **FM#4 irreversibility.** The handoff itself only launches a *draft* session (reversible), so it is
  autonomous under #243; the target's downstream gated actions (a real send/spend) are surfaced on the
  record but stay the #13 owner gate. The A2A path grants no new authority.
- **Externally-verified metrics / production-grounded.** The registry reports no fabricated metric; the
  only "metric" it carries is a declared `costTier` estimate. The observable call path is grounded in the
  real launch receipt — the `marketing_tasks` row the brief dispatch writes (read back by the #-audit
  feed) — plus the returned `A2ACallRecord`. Receipts-as-observability, no new store.

### Where each piece lives

- **`agent-registry/contract.ts` (pure):** `AgentContract` + the metadata table + `buildAgentContract` /
  `agentContracts` / `contractForHandle` / `isFleetHandle` / `handleHasCapability`.
- **`agent-registry/registry.ts` (pure):** `buildAgentRegistry` + `RegistryEntry` + `AgentRegistry`.
- **`agent-registry/a2a.ts` (pure):** `decideA2ACall` + `sanitizeTask` + the depth/cycle bounds.
- **`agent-registry/types.ts`:** the observable `A2ACallRecord` / `A2ACallDecision` shapes.
- **`agent-registry/caps.ts`:** `AgentRegistryCaps` + `AGENT_REGISTRY_DEFAULTS` (enabled **false**,
  ownerWorkspaceOnly **true**, maxCallDepth 3) + `resolveAgentRegistryCaps` + `isOwnerWorkspace`.
- **`agent-registry/service.ts`:** `AgentRegistryService` (deps-injected, fakes in tests).
- **`agent-registry/default.ts`:** production wiring — binds the present handles to `listPersonas`, caps to
  `loadConfig(wid).agentRegistry`, and `dispatch` to the #235 brief front door.
- **`routes/agent-registry.ts`:** `GET /workspaces/:wid/agent-registry` (catalog) +
  `POST /workspaces/:wid/agent-registry/call` (a governed A2A call). Registered in `app.ts`.
- **`config/{schema,layers,loader}.ts`:** the new `agentRegistry` block — default OFF, owner-first, with
  the `RELOAD_AGENT_REGISTRY_ENABLED` / `RELOAD_AGENT_REGISTRY_OWNER_WORKSPACE_ID` env knobs.

## Consequences

- **No migration, no new table, no new authority.** Pure derivation over existing seams. Colocation stays
  green; no sibling-workspace migration risk.
- **Default-OFF, owner-workspace-first.** A deployment that sets nothing exposes the contract catalog
  read-only and enables **no** A2A call in any workspace — byte-for-byte today's behavior. ipop opts in
  via the managed layer / env.
- **The fleet is now machine-readable + composable** — the Agent Garden console can render the contracts,
  and SkillOpt-Sleep has a typed composition primitive — without a second protocol surface (the external
  A2A/ACP adapters in `protocols/` are untouched and remain the cross-org wire format).
- **Honest scope.** Today an A2A call is *triggered* through the human-authenticated route (the owner
  orchestrating, or a completing agent's handoff routed by an operator), because fleet agents run with
  built-in tools only and cannot spawn sessions mid-run. The execution path is the existing audited
  launcher. A fully agent-initiated, in-session A2A tool is a deliberate follow-up (mirroring ADR-0012's
  "we deliberately do not synchronously execute the agent here").

## Alternatives considered

- **A persistent `agent_registry` / `a2a_calls` table.** Rejected as premature (ADR-0012's reasoning): the
  seeded personas already *are* the per-workspace roster and the `marketing_tasks` launch receipt already
  *is* the durable call record. New tables would duplicate state, risk divergence, and trip the migration
  gotchas. Noted as a follow-up if rich, queryable call-graph history is needed.
- **Extend the external `protocols/a2a/map.ts` JSON-RPC surface for the internal fleet.** Rejected: that
  is the cross-org wire format with its own conformance schema; bending it inward would couple two
  audiences and add a network hop the internal launch seam doesn't need.
- **A new launch path for agent-to-agent calls.** Rejected outright — it would fork the #59/#96/#71 gates
  and become a weaker side door. The whole point is to reuse the one audited launcher.

## Follow-ups (deferred)

- A fully agent-initiated, in-session A2A call (a built-in-safe handoff tool) once the runtime supports it.
- A durable, queryable A2A call-graph (the persistent table above) if the console needs call history.
- Render the contract catalog in the Agent Garden console surface.
- Feed `costTier` from measured per-session compute once #71 usage attribution is per-persona.
