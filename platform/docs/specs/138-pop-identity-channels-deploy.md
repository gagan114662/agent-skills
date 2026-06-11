# Spec: Reload Platform — Live ipop must match what shipped: pop identity, preloaded department channels, API deploy pipeline (Issue #138)

> Implements [#138](https://github.com/gagan114662/agent-skills/issues/138). **Builds on #122/#124**
> (brand-as-env source of truth), **#123** (marketing department fleet blueprint + seeder), **#58**
> (layered config), **#108** (Fly API + Vercel web split). Lifecycle: **DEFINE** artifact → atomic plan
> → TDD failing-first → ADR → one PR. **Video gate waived by the owner.**
>
> Proof demo: [`scripts/demos/138-pop-channels.sh`](../../scripts/demos/138-pop-channels.sh).

## Objective

The owner reported (2026-06-11) that the live https://ipop.ai shows the old plain shell: no pop
identity, an empty channel list ("Pick a channel to start"), and none of the marketing department
channels. Root cause: there was **no Fly deploy pipeline**, so api.ipop.ai ran a hand-deployed image
predating the marketing fleet (#123) and pricing rails (#125); and the full brand identity was never
implemented in the web app. Three gaps, one PR:

1. **Brand** — implement the owner-approved "pop" identity in the web console: Paper `#F6F1E7` / Ink
   `#171310` / Pop Vermilion `#FF4524`, a popped i-dot wordmark + Pop Mark, a department spectrum,
   playful motion (swell→overshoot→settle `cubic-bezier(.2,1.4,.3,1)`, squash & stretch, happy wiggle),
   and the Innocent-Drinks house voice on empty/error/welcome states ("made by robots, steered by
   humans"). The brand book is committed at `docs/brand/ipop-brand-identity.html` as the source of truth.
2. **Preloaded channels** — every workspace gets one channel per marketing department
   (SEO/Social/Content/Email/Paid/Analytics/Brand) wired to the #123 fleet agents
   (scout/echo/quill/postmark/bid/lens/mark), **seeded on workspace creation AND backfilled idempotently
   on boot** for pre-existing workspaces (the owner's `019eb395…` predates the fleet).
3. **Deploy pipeline** — a GitHub Actions workflow that deploys the API to Fly app `reload-api` on push
   to `main` (path filter `platform/**`) using a `FLY_API_TOKEN` secret, documented setup, plus a
   one-time manual deploy so current main goes live.

**Constraints (held):** no weakening of approval gates; external sends stay #13-gated; migrations
numbered by issue convention.

## Design

### 1. Brand (web, `apps/web`)
- **Palette** lives in `src/styles.css :root` — the legacy `--bg`/`--text`/`--accent` token names are
  kept (the whole app keys off them) but now resolve to Paper/Ink/Pop-Vermilion; adds `--paper`/`--ink`/
  `--vermilion`, a `--dept-*` spectrum, the `--pop-ease` curve, and fixes the latent undefined `--border`.
- **Motion** — `@keyframes` `swell-pop`, `squash-stretch`, `happy-wiggle`, `pop-dot`, all gated behind
  `@media (prefers-reduced-motion: reduce)`.
- **Wordmark** — a new `components/Wordmark.tsx` renders `BRAND.name` with a popped i-dot (the dot is a
  separate animated element; the plain name is exposed via `aria-label`). It is **not** a chrome
  component, so it can render rich markup while the chrome components stay free of hardcoded brand
  strings (the `brand.test.ts` rule). The three chrome components (`Workspace`/`AuthGate`/
  `ChannelSidebar`) render `<Wordmark/>` and keep importing from `../brand.js`.
- **Voice** — centralized in `brand.ts` as `VOICE` (welcome/empty/offline/loading + the sign-off) and
  `DEPARTMENT_SPECTRUM`/`departmentColor()`; consumed by `MessagePane`/`AuthGate`/`Workspace`. The
  server fleet (#123) already carries the same voice in `marketing/blueprint.ts`.

### 2. Preloaded channels (server)
- **Enable for prod via the config env base layer (#58):** `loader.ts` reads `RELOAD_MARKETING_ENABLED`
  / `RELOAD_MARKETING_SEED_WELCOME_TASKS` into the `marketing` block. Hard default stays **OFF**
  (`MARKETING_DEFAULTS`), so dev/tests/other deployments are unchanged; `fly.toml [env]` flips it on for
  ipop. A managed layer still wins (the lock). `seedWelcomeTasks=false` ⇒ the seed/backfill launches **no**
  welcome sessions (no spend) — @mentions still go through the venture + #13 gates.
- **Seed-on-signup** is the existing `maybeAutoSeedOnSignup` hook (#123) — now active in prod because the
  env enables it.
- **Boot backfill** — `runMarketingBackfill` (pure, seam-injected; `marketing/backfill.ts`) iterates every
  workspace, seeds each enabled one that has a human owner, best-effort per workspace. `default.ts`
  binds the real repos as `backfillMarketingDepartments(log)`; `index.ts` runs it once on boot like the
  #70 reaper sweep. It reuses `seedMarketingDepartment` made **idempotent-on-messages** (intros post only
  when an agent/`#general` is first created), so re-running on every reboot never spams the rooms.

### 3. Deploy pipeline
- `.github/workflows/fly-deploy.yml` — push to `main` on `platform/**`, `flyctl deploy --remote-only`,
  authenticated by the `FLY_API_TOKEN` secret, then polls `/readyz` as its own proof. Skips cleanly when
  the token is unset. The image self-migrates on boot (no separate migration step).
- Setup documented in `docs/runbooks/fly-deploy.md` (+ pointer from `operations.md`).
- One-time manual deploy: `cd platform && flyctl deploy --remote-only` from the owner's flyctl session.

## No new migration
This issue ships **no schema migration**. Preloading is data, created through app logic (persona token
minting can't be expressed in SQL), so it runs as an idempotent boot backfill rather than a data
migration — which also avoids the shared-sequence sibling-collision hazard noted in ADR-0099.

## Test plan (TDD, failing-first)
- `seed.test.ts` — intros post only on creation; re-seed posts no new messages (idempotent-on-messages).
- `config-loader.test.ts` — `RELOAD_MARKETING_*` env parsing; default stays OFF; managed layer still wins.
- `backfill.test.ts` — seeds enabled+owned workspaces; skips disabled / owner-less; best-effort on failure.
- `marketing-backfill.test.ts` (integration, real Postgres) — a pre-existing empty workspace gets the
  full agency; idempotent on a second boot; no-op when disabled.
- Web: `Wordmark.test.tsx` (popped i-dot + accessible name), `brand.test.ts` (Vermilion accent, voice,
  spectrum, palette + motion in the stylesheet), updated chrome/voice regression tests.

## Acceptance
Live ipop.ai shows the pop identity + the seven department channels; `api.ipop.ai/readyz` green;
`/me/channels` returns the department roster for the owner workspace.
