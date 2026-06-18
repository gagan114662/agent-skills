# ADR-0371: Seed a named department of agent personas — the reload.chat "team"

- **Status:** Accepted (gated in-repo logic; nothing enabled in production) (shipped in PR for #371)
- **Date:** 2026-06-18
- **Context issue:** [#371](https://github.com/gagan114662/agent-skills/issues/371) — give the
  coordination view a TEAM of distinct named agents (roles + handles + colors) instead of generic
  singletons, so the members rail and authored messages read as a real department.
- **Epic:** [#359](https://github.com/gagan114662/agent-skills/issues/359) — make the reload.chat vision
  real on ipop.ai (agents visibly coordinating + doing real marketing).
- **Builds on:** [ADR-0002](0002-data-model.md) (a member is a human OR an agent, kind + display name —
  agents are first-class participants), [ADR-0123](0123-marketing-department-fleet.md) (the #59 persona
  seam this reuses to mint agent members), [ADR-0282](0282-agent-registry-a2a.md) (the registry contract
  shape the roster projects into), [ADR-0013](0013-approval-gates.md) (the #13 gate — the only way any
  real action happens), [ADR-0200](0200-premortem-panel.md) (the rails this answers to),
  [ADR-0243](0243-money-only-approval.md) (seeding mints identity only — no money/action path),
  [ADR-0352](0352-agent-coordination-surface.md) (the default-OFF coordination UI whose members rail
  renders this footer).
- **Precedent:** mirrors the owner-first / default-OFF config shape of `agentRegistry` (#282) and
  `garden` (#284) — same owner-workspace-first rollout marker, fail-closed gate, byte-for-byte today's
  behavior when unset.

## Context

reload.chat feels alive because it shows a **team** of distinct named agents with roles — a Product
owner/lead, an SEO, a Designer, a Developer, QA, DevOps — each posting in their own voice, with a footer
like "6 humans · 7 agents · 247 decisions captured".

The audit (epic #359) confirmed ipop already has the primitives: agents are first-class members (the
`members` table, `kind="agent"`, display name), personas mint agent members through the #59 path
(`definePersona`), and the #282 agent registry projects fleet contracts per workspace. What was missing was
a **seeded department of personas with roles/handles/colors** for the owner workspace, plus the members-rail
footer. The existing #123 marketing fleet is a *different* team (SEO/social/content/email/ads/analytics/
brand/reach); the reload.chat team is a product/engineering department.

Two realities shaped the decision:

1. The `members` table stores only `kind` + `displayName` — there is no `role`/`color` column. Adding one to
   a core table for a display concern is invasive and risks every member path.
2. The example roster (`@scout` SEO, `@lens` Design, `@echo` DevOps) overlaps handles with the marketing
   fleet (`scout` SEO, `lens` analytics, `echo` social). A handle is one underlying agent member.

## Decision

Add a **pure, additive, default-OFF, owner-workspace-first** department module
(`platform/apps/server/src/department/`) that seeds the named team and renders the rail — **identity /
display only, no new action path**.

- **Roster as a derived blueprint, not stored columns** (`blueprint.ts`). The roster — handle, display
  name, department, **role** label, **color** accent, lead flag, identity prompt — is a pure source of
  truth. Role/color are *projected* at read time (the same "derived, not stored" call ADR-0012/#282 made
  for contracts), so there is **no migration** and no change to the `members` table. The default is the
  reload.chat team: `@hermes` (Product owner / lead), `@scout` (SEO), `@lens` (Design), `@atlas`
  (Developer), `@sentinel` (QA), `@echo` (DevOps). **Configurable:** `department.roster` config overrides
  rename/relabel/recolor any teammate (`resolveDepartmentRoster`); an unknown handle or malformed color is
  ignored (fail-safe).
- **Idempotent seed over the existing #59 seam** (`seed.ts`). Each teammate is ensured by @handle — minted
  as an agent member + persona exactly as the #123 marketing seed does, carrying the read/draft tool
  ceiling and **no send/spend tool**. Re-running creates nothing new; reversible through the existing #9
  deactivate path. A handle that coincides with an already-seeded fleet agent (e.g. `scout`) is **reused,
  never duplicated** — it is the same agent member; each surface (#123 fleet vs #371 team) projects its own
  role label.
- **Registry presence reusing the #282 shape** (`registry.ts`). The roster builds #282-shaped
  `AgentContract` / `RegistryEntry` values (read-only risk tier, empty `gatedActions`), mirroring
  `buildAgentRegistry`: an entry is `enabled` only when the flag is on AND the persona is present AND the
  workspace is in owner-first scope. Reusing the types means no drift; building them directly (not via the
  marketing metadata table) avoids polluting the marketing-derived catalog with the overlapping handles.
- **Members-rail footer grounded in the #13 gate** (`rail.ts`). `buildMembersRail` renders
  "{n} humans · {n} agents · {n} decisions captured". "Decisions captured" is the count of #13 approval
  requests that reached a human decision (`approved` / `executed` / `failed` / `rejected`) — a real
  governance count, never a vanity number (#200 §2). The web `MembersRail` (the #352 coordination surface)
  renders the same line from live directory counts + the best-effort decision count.
- **Config block** `department` (schema + layers replace-merge + loader env), default **OFF**,
  `ownerWorkspaceOnly: true`, reusing the established #258 owner marker
  (`RELOAD_MARKETING_OWNER_WORKSPACE_ID`; a dedicated `RELOAD_DEPARTMENT_OWNER_WORKSPACE_ID` overrides it).
  A deployment that sets nothing seeds nobody — byte-for-byte today's behavior.
- **Surface** `GET /me/department` (read-only roster + rail; always listable) and
  `POST /me/department/seed` (human-only, owner-gated, idempotent; 409 + nothing created when out of scope).

## #200 rails

- **Owner-first + default-OFF + fail-closed.** `isDepartmentSeedEnabledForWorkspace` gates every create:
  the flag must be on AND the workspace named; enabling without naming the owner seeds nobody.
- **Idempotent + reversible.** Seed keys on @handle; deactivation uses the existing #9 path.
- **No new action path (#200, #243).** Personas are identity/display only — draft tools, no send/spend. The
  registry contracts carry `gatedActions: []` and a `read_only` risk tier. Every real action a teammate's
  draft implies still flows through the **#13** gate; seeding spends no money and adds no autonomous path.
- **Untrusted content stays DATA.** Configurable roster overrides are sanitized (validated handle/role/
  color); a bad value is dropped, never executed. The footer's "decisions" count is derived from the gate,
  not from any agent-authored text.

## Consequences

- The owner workspace's members rail lists the named personas with roles/colors and shows the reload.chat
  footer; messages authored by these members render with the correct persona identity/handle/color.
- No migration; no change to the `members` table or to any existing surface when the flag is unset.
- The overlap with the #123 marketing handles is documented and benign: both features point at the same
  underlying agent member, each projecting its own role. Both are default-OFF; an owner typically enables
  one team per workspace.
- Flipping the production flag is an owner-gated operational follow-up (per ADR-0352 §2), not done in this
  implementation PR.
