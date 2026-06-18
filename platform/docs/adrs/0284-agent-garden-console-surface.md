# ADR-0284: Agent Garden surface in the v5 console (browse + enable agents)

- **Status:** Accepted (slice 1 shipped in PR for #284)
- **Date:** 2026-06-18
- **Context issue:** [#284](https://github.com/gagan114662/agent-skills/issues/284) — a customer-facing
  "garden" in the v5 console to browse the department agents (scout/lens/bid/echo/postmark/quill/mark), see
  each agent's capability/contract and pricing, and enable/disable them per workspace. Revenue-facing:
  clear per-agent value, one-click enable behind the existing flag + #13 approval seams (default OFF, owner
  workspace first). Reads from the agent registry.
- **Builds on:** [ADR-0282](0282-agent-registry-a2a.md) (the agent registry contract — `AgentContract`,
  `agentContracts()`, `buildAgentRegistry`, the per-department risk/cost tiers this surface renders and
  governs against — its hard dependency), [ADR-0123](0123-marketing-department-fleet.md) (the blueprint /
  seeded personas that are the production-grounded "present" fact), [ADR-0013](0013-approval-gates.md) /
  [ADR-0243](0243-money-only-approval.md) (the #13 approval queue; the money-only default and the
  structural always-gate carve-out), [ADR-0258](0258-connect-once-integrations.md) (the
  `connection.connect_account` structural-always-gate, recorded-only consent pattern this enable-gate
  mirrors), [ADR-0035](0035-config-layering.md) (the layered feature-flag config), [ADR-0223](0223-decision-maker-resolver.md)
  (the structural-not-instructions injection-quarantine pattern), [ADR-0200](0200-premortem-panel.md) (the
  standing premortem this answers to).

## Context

ADR-0282 made the department fleet **machine-readable**: every agent now carries a declared
`AgentContract` (capabilities, typed IO, tool ceiling, `costTier`, `riskTier`, downstream `gatedActions`),
derived from the blueprint with no new table. What it deliberately deferred (its own follow-up list:
"render the contract catalog in the Agent Garden console surface") is the customer-facing surface: a place
the owner can **see** what each agent is for and what it costs, and **turn each one on or off for their
workspace**.

Two things make this more than a read-only catalog render:

1. **Enable is a per-workspace decision with state.** ADR-0282's `RegistryEntry.enabled` is a pure
   projection (`flag ∧ present ∧ ownerOk`) — there is no per-*agent* toggle. The Garden needs one: the
   owner enabling Scout but not Bid. That is durable per-(workspace, agent) state the catalog projection
   does not carry.

2. **Enabling an outbound/spend agent is an owner decision, not a free switch.** Echo/Postmark/Bid (and
   #280's Comet/Reach) are `external_send` risk tier — their whole purpose is work that, once approved,
   leaves the building (premortem #200 FM#4: deliverability, brand, money are irreversible). Turning such
   an agent **on** is exactly the kind of "never post-hoc, always the human's call" decision the premortem
   reserves for the owner.

The standing premortem (#200) sets the rails this surface must answer to: any metric must be externally
verified (FM#2), verification must touch reality (FM#3), irreversible/risky actions must be human-gated and
OFF by default (FM#4), and no agent-supplied content may steer an autonomous write (FM#6).

## Decision (this slice = slice 1)

Add a `garden/` module — **pure-first**, deps-injected service, one small workspace-scoped table for the
per-agent enable state — plus a `/me/garden` REST surface and a `GardenPanel` in the console settings
overlay. It **reuses ADR-0282's registry verbatim** (`agentContracts()` is the only source of the agent
list / contract / tiers) and the **existing #13 approval queue** (no new gate, no new launch authority).

### 1. Per-agent enable state, with a production-grounded read (FM#3)

A new `garden_agent_enablements` table holds **one row per (workspace, agent handle)** with a `state ∈
{enabled, pending_approval, disabled}`. The name is deliberately NOT `growth_`/`demand_`/`venture_`/
`moat_`-prefixed, so the #155 colocation gate does not class it as a governed metric surface; it carries no
metric and no credential.

The Garden view does **not** trust that row alone. The pure `projectGardenView` cross-checks the persisted
state against the **production-grounded** fact ADR-0282 already uses: is the persona actually **seeded**
(present) in the workspace (`listPersonas`)? An agent is reported `active: true` **iff** the feature flag is
on for the workspace **AND** its persisted state is `enabled` **AND** the persona is present. A toggle that
says "enabled" for an agent that is not actually seeded is surfaced honestly as `enabled` state +
`active: false` + an `inactiveReason` — never as a green "on". This is FM#3 ("self-reported state is
fiction; verification must touch reality"): the enabled-state the owner sees is reconciled with the live
roster, not with a self-report.

### 2. Enabling an irreversible-action agent is #13-gated, OFF by default (FM#4)

The pure `decideGardenEnable(contract, caps, …)` is the single place an enable is governed:

- **`read_only` / `internal_draft`** agents (Scout/Lens audits, Quill/Mark drafts — nothing leaves the
  building) → `outcome: "enable"`: reversible and money-free, so the state flips to `enabled` directly.
- **`external_send`** agents (Echo/Postmark/Bid/Reach — outbound, irreversible blast radius) →
  `outcome: "needs_approval"`: the service parks a **PENDING `garden.enable_agent` #13 request** and sets
  the state to `pending_approval`. There is **no autonomous-enable path** for an irreversible-capable
  agent; the owner approves in the existing decision queue, and the recorded-only executor flips the state
  to `enabled`. Default OFF: an unset agent is `disabled`.

`garden.enable_agent` is a **structural always-gate, recorded-only** action — it is NOT money (so it is not
in `MONEY_ACTIONS`), exactly like `connection.connect_account` (ADR-0258), `hosted.publish` (ADR-0266) and
`skillopt.adopt_skill_edit` (ADR-0283): the always-gate is enforced by the service (which has no autonomous
path for the external-send tier), not by the money predicate. It is never submitted through the #13 action
route; the Garden service evaluates it against the same workspace `approval_policies` and parks the request
directly, just like those siblings. **Disabling is always immediate** (it only ever *reduces* blast radius,
so it is never gated).

### 3. Default-OFF, owner-workspace-first feature flag (FM#4 / FM#5)

A new layered `garden` config block (`enabled` default **false**, `ownerWorkspaceOnly` default **true**,
`ownerWorkspaceId`) gates the surface, mirroring `agentRegistry`. With the flag off the catalog still
**lists** (browse is harmless — the contracts are inspectable), but `canManage` is false, every agent is
`active: false`, and the enable/disable routes 409. Owner-workspace-first: until `ownerWorkspaceOnly:false`,
only the owner workspace can manage. A deployment that sets nothing changes nothing — today's behavior is
byte-for-byte unchanged (no `garden` rows, no surface effect).

### 4. Pricing = the declared cost tier, never a fabricated number (FM#2)

"Per-agent pricing" is the contract's `costTier ∈ {low, medium, high}` rendered as a coarse compute-weight
label (`gardenPriceLabel`). We deliberately surface **no dollar figure and no usage metric**: a fabricated
"$X/mo" or "saved you N hours" would be a self-reported metric with no external receipt (FM#2). The price
signal is the same developer-authored tier ADR-0282 already declares; real per-agent dollar pricing waits
on measured per-persona usage attribution (an ADR-0282 follow-up) and a Stripe-grounded plan mapping.

### 5. Injection defense on every projected field (FM#6)

The contract free-text the Garden renders (and that flows into the #13 request `summary`) is treated as
untrusted **DATA**: `sanitizeGardenText` strips control characters, collapses whitespace, caps length, and
neutralizes instruction-frame markers before any string reaches the client or the approval summary. Today
the contract metadata is developer-authored, so this is **defense-in-depth** — but a future agent-authored
or registry-sourced contract field can never inject the console, the audit feed, or (critically) the #13
approval summary the owner reads when deciding. The #13 `summary` is built **structurally** from the
sanitized handle + display name, never by interpolating raw metadata. This is the ADR-0223 quarantine
discipline: the defense is architectural (metadata never becomes an instruction), with sanitation as the
backstop.

### Where each piece lives

- **`garden/caps.ts` (pure):** `GardenCaps` + `GARDEN_DEFAULTS` (enabled **false**, ownerWorkspaceOnly
  **true**) + `resolveGardenCaps` + `isOwnerWorkspace` + `isGardenManageInScope`.
- **`garden/sanitize.ts` (pure):** `sanitizeGardenText` (FM#6 backstop).
- **`garden/pricing.ts` (pure):** `gardenPriceLabel(costTier)` — coarse tier, no fabricated number.
- **`garden/types.ts`:** `GardenAgentState`, `GardenAgentView`, `GardenView`.
- **`garden/decide.ts` (pure):** `decideGardenEnable` / `decideGardenDisable` (the always-gate decision) +
  `projectGardenView` (the production-grounded, sanitized projection).
- **`garden/service.ts`:** `GardenService` (deps-injected: caps, present handles, state get/set, park,
  optional observe — fakes in tests).
- **`garden/default.ts`:** production wiring — caps from `loadConfig(wid).garden`, present handles from
  `listPersonas`, state from the new repo, park via `createRequest` with `GARDEN_ENABLE_AGENT_ACTION`.
- **`db/schema/garden.ts` + `db/repositories/garden.ts` + `drizzle/0284_garden_agent_enablements.sql`
  (+`.down.sql`):** the one workspace-scoped table + its store. Numbered 0284 by issue (ADR-0099).
- **`approvals/policy.ts`:** `GARDEN_ENABLE_AGENT_ACTION = "garden.enable_agent"` (NOT in `MONEY_ACTIONS`).
- **`routes/garden.ts`:** `GET /me/garden` (catalog + per-agent state) + `POST /me/garden/:handle/enable`
  + `POST /me/garden/:handle/disable`. Registered in `app.ts`.
- **`config/{schema,layers}.ts`:** the `garden` block — default OFF, owner-first.
- **web `components/Garden.tsx` (pure) + `GardenPanel.tsx` (container) + `Garden.test.tsx`:** the settings
  panel, mounted in `ConsoleView`'s settings overlay; copy in `brand.ts` `GARDEN`.

## Consequences

- **One small table, reversible migration, no new authority.** The enable state is the only new persistence;
  governance reuses the #13 queue and the launch path is untouched. Colocation stays green (non-governed
  table name).
- **Default-OFF, owner-workspace-first.** A deployment that sets nothing exposes a read-only catalog and
  enables nothing — today's behavior. ipop opts in via the managed layer / env.
- **The fleet is now browsable and per-workspace toggleable**, with outbound/spend agents gated behind the
  owner's explicit yes and the displayed on/off state reconciled against the live roster.
- **Honest pricing scope.** The surface shows a cost tier, not a dollar number — no fabricated metric.

## Phased plan (the epic)

- **Slice 1 (this PR):** browse the 7 department agents (contract, capability, cost tier, risk tier) +
  enable/disable per workspace, with `external_send` enable #13-gated and OFF by default, production-grounded
  active-state, injection-defended projection, behind the `garden` flag (owner-first). ADR + full unit
  tests; tsc/eslint/build/suite/colocation green.
- **Slice 2 (follow-up):** the recorded-only `garden.enable_agent` executor wired into the #13 executor
  registry so an owner approval flips `pending_approval → enabled` end-to-end (this slice persists the
  pending state and parks the request; the post-approval state flip is the executor's job).
- **Slice 3 (follow-up):** seed/unseed the persona on enable/disable so `active` reflects a real roster
  change the owner triggers from the Garden (this slice reconciles against the *existing* roster but does
  not yet mutate it), reusing the #123/#138 department seed seam.
- **Slice 4 (follow-up):** real per-agent dollar pricing once per-persona usage attribution (ADR-0282
  follow-up) and a Stripe-grounded plan mapping exist — replacing the coarse cost tier with an
  externally-grounded number (FM#2).

## Alternatives considered

- **Derive enable from `agentRegistry.enabled` (no new table).** Rejected: that flag is per-*workspace*
  (all-or-nothing for A2A), not per-*agent*. The Garden's product is choosing *which* agents — that is
  durable per-(workspace, agent) state a pure projection cannot hold.
- **Gate every enable (read-only agents too).** Rejected as approval theater (FM#5: zero-EV approvals make
  the gate a rubber stamp). A read-only audit agent carries no irreversible blast radius; gating it trains
  the owner to rubber-stamp. We gate exactly the `external_send` tier the premortem reserves for the human.
- **Make `garden.enable_agent` a money action.** Rejected: enabling an agent moves no money (ADR-0243).
  It is a *consent/behavior* decision, modeled as a structural always-gate exactly like
  `connection.connect_account` — recorded-only, never in `MONEY_ACTIONS`.
- **Seed/unseed the persona synchronously on toggle (in this slice).** Deferred to slice 3: it couples the
  enable decision to the #123 seed seam and a real roster mutation. Slice 1 keeps the decision pure and the
  read production-grounded against the *existing* roster, which is the safe, testable first cut.
