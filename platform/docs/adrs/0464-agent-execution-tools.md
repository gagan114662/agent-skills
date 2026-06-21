# ADR-0464: Agent execution tools (read/draft → act, behind a human-approval boundary)

- **Status:** Accepted (framework + first 3 tools shipped in PR for #464)
- **Date:** 2026-06-21
- **Context issue:** [#464](https://github.com/gagan114662/agent-skills/issues/464) — every agent tool in the
  fleet is read/draft (`seo.audit`, `*.draft_*`, `*.outline`, `ads.plan_budget`, `analytics.report`,
  `reach.draft_opener`). No publish/post/send/spend tool exists, yet agents are labelled "Acts outside."
  Add execution tools gated behind human approval, starting with content publish and social draft-to-post.
- **Builds on:** [ADR-0013](0013-approval-gates.md) (the #13 approval queue — the executor registry, the
  PENDING request that IS the audit-of-record), [ADR-0243](0243-money-only-approval.md) (the money-only
  default + the structural always-gate carve-out for outward/irreversible actions), [ADR-0282](0282-agent-registry-a2a.md)
  (the `AgentContract` `gatedActions` this framework turns from observability into a real, parked request),
  [ADR-0266](0266-hosted-publishing.md) / [ADR-0269](0269-social-aggregator-bridge.md) /
  [ADR-0187](0187-venture-factory.md) (the per-department services that own the live actuation behind each
  gate — `hosted.publish` / `social.publish_post` / `venture.ad_spend`), [ADR-0200](0200-premortem-panel.md)
  (the standing premortem: outward/irreversible actions are never post-hoc, never agent-initiated).
- **Coordinates with:** [#463](https://github.com/gagan114662/agent-skills/issues/463) (the outbound
  connectors). This ADR is the **execution-tool framework** — the agent-facing seam that classifies the
  boundary, parks the approval, and audits. #463 owns wiring the LIVE connectors (CMS / X / LinkedIn / Ads)
  behind these same gates. The framework is deliberately separable: a tool parks a recorded-only approval
  today and the per-department executor goes live when #463 lands its connector.

## Context

The fleet could **think** but not **act**. Each department agent (`marketing/blueprint.ts`) carries only the
read/draft Claude Code tools — `Read`, `Grep`, `Glob`, `WebSearch`, `WebFetch` — so its "acts outside" label
was aspirational: it could draft a post and say "a human just has to paste," but had no tool that publishes,
posts, sends, or spends. Meanwhile the per-department **services** for the live actions already exist
(`hosted.publish`, `social.publish_post`, `venture.ad_spend`, `outreach.send`, …), each with its own
structural always-gate, reachable only over HTTP — never as a tool an agent could invoke.

The gap is a missing **layer**, not a missing service: there was no single agent-facing seam that turns an
agent's request to act into a parked, audited, human-gated approval. Adding send/spend tools to each agent
ad-hoc would scatter the gate and risk an autonomous-fire path — exactly what the premortem forbids.

## Decision

Add `agent-tools/` — a small, pure-cored framework with one invariant:

> **An execution tool never fires. `invoke()` validates, classifies the human-approval boundary, parks a
> PENDING #13 approval, and writes an audit entry. The real-world action runs later, only after a human
> approves it, through the existing per-department executor.**

- **`types.ts`** — the pure `ExecutionToolSpec`: a `name`, the `gatedAction` it parks, a `visibility`
  boundary (`public` / `outbound` / `money`), and a single pure `prepare(args)` that validates and builds an
  injection-safe summary + a **routing-only** payload (ids/slugs/networks — never free-form body, #200 §6).
  There is no `execute` on a tool, by construction.
- **`registry.ts`** — the first three concrete tools, one per boundary, so the framework demonstrably gates
  each kind: `content.publish` (PUBLIC → `hosted.publish`), `social.post` (OUTBOUND → `social.publish_post`),
  `ads.launch_campaign` (MONEY → `venture.ad_spend`, the budget carried as the request `amount`).
- **`decide.ts`** — `isGatedAction` (permission: a tool may only park an action the #13 taxonomy already
  gates — no orphan authority) and `classifyExecutionBoundary` (names the boundary; every case gates — there
  is no un-gated outcome, matching the social/hosted structural always-gate).
- **`service.ts`** — `ExecutionToolService.invoke()`: fail-closed at every step (unknown tool, invalid args,
  un-gated action all refuse WITHOUT parking), and **every** outcome — parked or refused — is audited.
- **`default.ts` + `routes/agent-tools.ts`** — production wiring over the real #13 queue (`createRequest`,
  always `status: "pending"`) and a per-invocation structured log line. `GET /me/agent-tools` lists the
  catalog; `POST /me/agent-tools/:name/invoke` parks the approval and returns `202` with the
  `approvalRequestId`. Per-workspace flag (`RELOAD_AGENT_TOOLS_ENABLED`, default ON — the gate, not the flag,
  is the guard, since the framework can only ever PARK).

### Audit trail

The parked PENDING `approval_requests` row (plus its `requested` event) **is** the durable audit-of-record —
the #147 audit feed already reads it, so an agent's request to act is visible in the decision queue and the
audit trail with its action type, exact amount, and routing payload. The service additionally emits a
structured log line for every invocation, including refusals, so a blocked attempt is never invisible.

## Consequences

- An "Acts outside" agent now has a real outbound tool that **only fires after explicit approval** (the issue's
  acceptance) — the action is parked, shown to the owner with its exact boundary (public surface / outbound /
  the precise spend), and executes only on approval.
- The gate is centralized and uniform: one seam classifies + parks + audits for every execution tool; adding a
  tool is one registry entry pointing at an existing gated action.
- Recorded-only until #463: parking is real today; the live connector behind each gate is #463's job. The
  framework makes that a wiring change behind an already-enforced approval, not a new authority.
- Scope held: no live connector, no new approval-taxonomy entry, no migration. The contract `gatedActions`
  (ADR-0282) graduate from observability to an actually-parked request, with no change to the registry.
