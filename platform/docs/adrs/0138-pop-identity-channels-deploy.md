# ADR-0138: Live ipop must match what shipped — pop identity, preloaded department channels, API deploy pipeline

- **Status:** Accepted (shipped in PR for #138)
- **Date:** 2026-06-11
- **Context issue:** [#138](https://github.com/gagan114662/agent-skills/issues/138)
- **Spec:** [docs/specs/138-pop-identity-channels-deploy.md](../specs/138-pop-identity-channels-deploy.md)
- **Builds on:** [ADR-0123](0123-marketing-department-fleet.md) (the marketing fleet blueprint + seeder
  this turns on and backfills), #122/#124 (brand-as-env source of truth + the no-hardcoded-strings
  guard), [ADR-0035](0035-config-layering.md) (the layered config whose env base layer enables the
  fleet), and #108 (the Vercel-web / Fly-API split this deploy pipeline completes).

> **Numbering note.** ADR/spec use the `0138` slot (the issue number), per the by-issue numbering
> convention (ADR-0099). This change ships **no migration**, so it adds nothing to the shared sequence.

## Context

The live product had drifted from the repo. https://ipop.ai showed the old plain shell: no pop identity,
an empty channel list, no marketing departments. The cause was two gaps. (1) There was **no Fly deploy
pipeline** — api.ipop.ai ran a hand-deployed image from days earlier, so the marketing fleet (#123),
pricing (#125), and everything since never went live. (2) The owner-approved "pop" brand identity was
never implemented in the web app, and the brand book it referenced (`ipop-brand-identity.html`) was not
even committed to the repo, so it could not be built against and had silently disappeared.

The marketing fleet (#123) existed but was **default-OFF and signup-only**: a config gate the live
deployment never opted into, and a seed path that only fires for *new* workspaces — so the owner's
pre-existing workspace (`019eb395…`) would stay empty even once the gate flipped.

## Decisions

1. **Commit the brand book as the source of truth, then mirror it in the app.** The owner-approved pop
   identity is reconstructed from the issue's specification and committed at
   `docs/brand/ipop-brand-identity.html` (a self-contained, viewable brand book using the real tokens).
   The web console mirrors it: Paper/Ink/Pop-Vermilion in `styles.css :root` (reusing the legacy
   `--bg`/`--text`/`--accent` token names so the whole app reskins), a department spectrum, the
   `cubic-bezier(.2,1.4,.3,1)` motion family (swell-pop / squash-stretch / happy-wiggle / pop-dot, all
   behind `prefers-reduced-motion`), and the Innocent-school house `VOICE` on empty/error/welcome states.

2. **The wordmark is a component, not inline markup — so the no-hardcoded-strings guard still holds.** A
   new `Wordmark.tsx` renders `BRAND.name` with a popped i-dot (the dot is a separate animated element;
   the plain name rides on `aria-label`). The three chrome components render `<Wordmark/>` and keep
   importing from `../brand.js`, so `brand.test.ts` still passes — a rebrand still flows from env.

3. **Enable the fleet for prod through the config env base layer, not by changing the default.** The hard
   default stays OFF (`MARKETING_DEFAULTS`, keeping `caps.test.ts` and every other deployment unchanged);
   `loader.ts` learns to read `RELOAD_MARKETING_ENABLED` / `RELOAD_MARKETING_SEED_WELCOME_TASKS`, and
   `fly.toml [env]` flips them on for ipop. A managed layer still overrides (the #58 lock). This is the
   intended "ipop opts in via a layer" mechanism, made reliable for a container (no managed.toml to bake
   into the image).

4. **Preload is channels + named agents, never welcome-session launches — so it cannot spend.**
   `seedWelcomeTasks=false` in prod. The seed/backfill creates the rooms and the seven personas and adds
   memberships; an @mention still goes through the venture gate (#96) and the #13 approval gate, and the
   live harness is `demo` — so enabling the fleet adds **no** new spend authority and weakens no gate.

5. **Backfill pre-existing workspaces idempotently on boot.** `runMarketingBackfill` (pure, seam-injected)
   sweeps every workspace once on boot (mirroring the #70 reaper sweep), seeding each enabled, human-owned
   one best-effort. To make re-running on every reboot safe, `seedMarketingDepartment` is made
   **idempotent-on-messages**: intros (and the `#general` welcome) post only when the agent/channel is
   first created. Channel-by-name and persona-by-handle matching already made structure idempotent; this
   closes the message side. This is the only path that reaches the owner's pre-existing workspace.

6. **Deploy the API to Fly on every push to main.** `.github/workflows/fly-deploy.yml` runs
   `flyctl deploy --remote-only` (auth: `FLY_API_TOKEN` repo secret), then polls `/readyz` as its own
   proof; it skips cleanly when the token is unset. The image self-migrates on boot, so a deploy is the
   whole story. Setup is documented in `docs/runbooks/fly-deploy.md`. A one-time manual deploy from the
   owner's flyctl session takes current main live immediately.

7. **No schema migration.** Preloading is data created through app logic (persona token minting isn't
   expressible in SQL), so it runs as an idempotent boot backfill rather than a data migration — which
   also sidesteps the shared-sequence sibling-collision hazard (ADR-0099).

## Consequences

- The live product matches the repo: the pop identity ships via Vercel on merge; the API (fleet, pricing,
  everything since the last hand-deploy) ships via Fly on push to main and on the one-time manual deploy.
- Every workspace — new and pre-existing — lands inside a working agency (seven department channels wired
  to the named fleet agents) instead of an empty channel list, with zero spend and no relaxed gates.
- Marketing stays OFF for every other deployment and for tests; only ipop's env opts in. The brand can
  still be re-themed entirely from `VITE_BRAND_*` + the `:root` tokens.
- The deploy pipeline's `platform/**` path filter means a web-only change also redeploys the API; that is
  a safe no-op rollout (idempotent, self-migrating image), accepted for simplicity per the issue.

## Follow-ups (deferred)
- Narrow the deploy path filter to `apps/server/**` + `packages/shared/**` + `fly.toml` if API redeploys
  on web-only changes become noisy.
- A managed `managed.toml` (per-tenant marketing overrides) if some tenants should opt out of the fleet.
- Department-spectrum theming could extend to the message pane header + members rail per active channel.
