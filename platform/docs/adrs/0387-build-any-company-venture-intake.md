# ADR-0387: Build & run ANY company — surface the dormant venture-loop intake behind a gated brief

- **Status:** Accepted (slice 1 — server gate + web brief surface — shipped in PR for #387)
- **Date:** 2026-06-19
- **Context issue:** [#387](https://github.com/gagan114662/agent-skills/issues/387) — ipop should start &
  run its OWN profitable companies / build ANY company, not just market itself. Today ipop only ever seeds a
  marketing team and only ever runs its one marketing "founding venture", even though the machinery to admit,
  score, fund and bootstrap an *arbitrary* company already exists.
- **Builds on:** [ADR-0096](0096-venture-loop.md)/#96 (the Venture Loop: SOURCE → RESEARCH → SCORE → DECIDE
  → ACT → LOOP, with the pure `decideVenture` gate and the epic emitter), #187 (the venture-factory company
  bootstrapper: provision → brand → landing → repo → deploy → seed_fleet → domain → payment → ads, with the
  #13 money boundary), [ADR-0200](0200-premortem-panel.md) (standing rails — content is DATA, no money path,
  owner-first), and the default-OFF owner-workspace-first config convention used by `attribution` (#386) /
  `finance` (#194) / `venture` (#96).

## Context

The "build any company" engine is **already built and wired** — four server modules (`venture/`,
`venture-factory/`, `venture-deploy/`, `venture-memory/`) implement idea → admission → score → fund →
bootstrap → run. Its core is **product-agnostic**: the intake `IdeaInput` (problem / targetUser / insight /
wedge / marketPath / optional segment) names no product type, and the pure scorer/gate reason over generic
YC-bar dimensions. The live routes (`routes/venture.ts`, registered in `app.ts`) already expose
submit / score / decide / advance / get.

It is **dormant** for two reasons, only the first of which this slice addresses:

1. **There is no console seam to brief a company idea into it.** `apps/web/src` made ZERO calls to the
   `/ventures` routes — a "build company X" goal had no path to `VentureService.submit`. So the only way a
   venture ever entered the loop was the hardcoded marketing founding venture.
2. (Out of scope here) Every `seed_fleet` path injects the **marketing** seeder, so even the bootstrap path
   stands up a marketing team; and the production evidence/LLM scorers are still deferred stubs.

This is an **ACTIVATE-don't-rebuild** situation. The smallest real, mergeable slice is to surface the
existing intake — let the owner brief ANY company idea from the console and run it through the already-live
#96 loop — behind a default-OFF, owner-workspace-first flag.

## Decision

Add a new **`ventureIntake`** config block (the standard 5 schema + 2 layer + 1 loader pattern, default-OFF,
owner-workspace-first, fail-closed: enabled-without-an-owner = nobody) and use it to gate the owner-facing
**brief submit** path, plus a matching web brief surface gated the same way.

**Server.**
- `config/schema.ts` — `ventureIntakeSchema` (`enabled?`, `ownerWorkspaceId?`), registered on the root
  schema, `ResolvedConfig`, `CONFIG_DEFAULTS`, and a `VentureIntakeConfig` type export. `config/layers.ts`
  — replace-merge of the block (a higher managed/owner layer fully owns it) + the resolved default.
  `config/loader.ts` — `RELOAD_VENTURE_INTAKE_ENABLED` / `RELOAD_VENTURE_INTAKE_OWNER_WORKSPACE_ID`
  (owner falls back to the marketing owner), mirroring `attribution`.
- `venture-intake/caps.ts` — `resolveVentureIntakeCaps`, `isOwnerWorkspace`, `ventureIntakeActive(caps,
  wid)`, identical in shape to `attribution/caps.ts`.
- `routes/venture.ts` — the existing `POST /workspaces/:wid/ventures` (the owner-facing brief submit path)
  now returns **409** when `ventureIntake` is not active for the workspace, mirroring the finance /
  attribution routes. The score / decide / advance / get routes are **unchanged**. With the flag unset
  (default / prod non-owner) the brief path is closed, so production is **byte-for-byte unchanged**.

**Web.**
- `api/types.ts` + `api/client.ts` — a `submitVenture(wid, VentureIdeaInput)` method hitting the live route,
  with `VentureIdeaInput` / `VentureIdeaDto` types.
- `components/console/venture-intake-flag.ts` — a pure default-OFF owner-first web gate
  (`shouldShowVentureIntake`, `VITE_RELOAD_VENTURE_INTAKE` + owner ws), mirroring the #352 coordination flag.
- `components/console/VentureBriefPanel.tsx` — a small five-field form (idea, one-line pitch, target
  customer, problem, why-now) mapped onto the loop's product-agnostic `IdeaInput`; mounted in `ConsoleView`
  only when the web gate resolves on for the owner workspace.
- `brand.ts` — a `CONSOLE.ventureBrief` copy section, and a tasteful one-line positioning reframe of the
  default tagline from "marketing agency" toward "an AI agency that builds & runs companies" (still
  env-overridable).

## Consequences

- **No new pipeline.** Submit + the heuristic score + the FUND epic emission are all existing, non-money
  paths. The funded build work (domain / payment / ad-spend in the venture-factory bootstrap) still routes
  through the **existing #13 owner approval gate** — this slice adds **no new money or irreversible action**.
- **Fail-closed on both sides.** The server route is gated independently of the web flag, so even a web flag
  flipped on without the server flag answers 409.
- **#200 rails.** The five fields are untrusted owner input — sent only as JSON DATA to the submit route and
  rendered back as plain text (no markup execution). Annotations / metadata can never widen scope or
  authorize an irreversible action.
- **Follow-ups (explicitly out of scope):** (a) a non-marketing fleet roster for `seed_fleet` so a bootstrapped
  company stands up the right team (the marketing seeder is hardcoded in `venture-factory/default.ts`);
  (b) the deferred live evidence gatherer + the #59 LLM scorer replacing the deterministic stubs.

## Alternatives considered

- **Broaden the fleet roster first.** Cosmetic without an intake seam — there'd still be no way to brief a
  non-marketing company. Rejected as a first slice.
- **Flip the venture-factory tick on.** Turns on autonomous money-spending bootstrap (domain / ads) before
  any human-brief surface exists — too big and too risky for slice 1. The brief surface is the wedge that
  makes the rest usable; the factory's money steps stay behind #13 regardless.
