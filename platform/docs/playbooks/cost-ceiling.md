# Cost ceiling runbook — the hosting bill can never surprise us

> Issue [#108](https://github.com/gagan114662/agent-skills/issues/108) · [ADR-0108](../adrs/0108-production-posture.md) · [Spec 108](../specs/108-production-posture.md)
> · builds on the #113 cost forecast ([ADR-0113](../adrs/0113-performance-capacity-rails.md)).
>
> **Premise:** a 24/7 hosted company must have a *bounded* monthly bill — a runaway loop, an autoscale
> event, or a forgotten machine must not be able to surprise-bill the founder. There are three layers,
> from hardest to softest. **Layer 1 is already in force in `fly.toml`.**

## The three layers

| Layer | Type | Where | What it does |
|---|---|---|---|
| 1. Fly machine cap | **hard** (vendor) | `platform/fly.toml` | Exactly **one** `shared-cpu-1x` / 512 MB machine, never autoscaled. |
| 2. Fly org spend limit | **hard** (vendor) | Fly dashboard / `fly` CLI | A dollar ceiling on the whole org's monthly spend + a billing alert. |
| 3. Infra budget forecast | **soft** (in-app) | `scale.infraBudgetCeilingCents` → `infraBudgetStatus` (#113) | Warns in the Founder Console **before** projected spend crosses the ceiling. |

### Layer 1 — the Fly machine is pinned to one box (already in place)

`fly.toml` hard-caps horizontal scale so hosting cannot fan out under load:

```toml
[http_service]
  auto_stop_machines = false
  auto_start_machines = false
  min_machines_running = 1   # exactly one machine — never autoscaled up

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
```

With `auto_start_machines=false` and a single machine, an HN hug or a runaway loop degrades *this one
box* (the #113 saturation metrics + #112 SRE loop catch that) — it can **never** silently spin up a
fleet of paid machines. To scale **up** is a deliberate, reviewed edit to `fly.toml` + `fly deploy`,
never automatic. Verify the live posture:

```bash
fly status --app reload-api        # expect exactly 1 machine, started
fly scale show --app reload-api    # expect shared-cpu-1x / 512MB, count 1
```

### Layer 2 — set a Fly org spend limit (the vendor hard stop)

The machine cap bounds *compute*, but managed Postgres storage, bandwidth, and Upstash can still drift.
Set an organization spend limit so Fly itself stops the bleeding and emails before the bill runs away:

```bash
# One-time: set a monthly hard spend limit on the org that owns reload-api.
# (Fly dashboard → Organization → Billing → "Spend limit"; or via the billing API.)
fly orgs show <org>                 # confirm which org owns reload-api
# Set the limit + alert threshold in the dashboard Billing pane (no stable CLI verb yet).
```

Pick a ceiling that is ~2–3× the steady-state bill (headroom for a bad day, a hard stop before a
runaway). Upstash has its own per-database budget alert — set the same way in the Upstash console.

### Layer 3 — the in-app forecast warning (already shipped in #113)

`infraBudgetStatus(projectedCostCents, ceilingCents)` (`apps/server/src/scale/forecast.ts`) projects
next month's spend from the `tenant_usage` trend and flags a breach **before** it happens. It is a
**read-only signal** surfaced in the Founder Console (#104) — it never blocks a launch (admission, #71,
is the only thing that blocks). Wire the ceiling via config (layered env < user < repo < managed):

```jsonc
// scale config — cents. 0 (default) = no ceiling (never warns).
{ "scale": { "infraBudgetCeilingCents": 5000 } }   // e.g. warn as projected spend nears $50/mo
```

Set it to roughly the **Layer-2 spend limit** so the founder sees the in-app warning *before* Fly's
hard stop fires.

## Alarm response — when a budget alert fires

1. **Confirm the source.** Founder Console infra-budget warning (soft, projected) vs a Fly/Upstash
   billing email (hard, actual). A soft warning is a heads-up; a hard alert means real money is moving.
2. **Find the driver.** Check `/metrics` saturation gauges (#113) + the #71 `tenant_usage` rows: is one
   venture/tenant burning compute (a runaway loop)? Is it storage growth (a backup/log leak)?
3. **Stop the bleed.**
   - Runaway loop → the #71 admission caps / the #99 maintenance flag (`reload maintenance on`) pauses
     the autonomy/cron loops instantly without a redeploy.
   - A bad venture → its kill-switch (#96) / lower its tenant concurrency cap.
   - Storage drift → prune old off-site dumps (the #99 retention) / rotate logs.
4. **Do NOT scale the machine up to "make the alert go away."** Scaling up raises the bill. Fix the
   driver first; scale only as a reviewed, deliberate decision.
5. **Record it.** If it was a real incident, link it from the #112 SRE postmortems / the Founder Console.

## Verify the guardrails are live

```bash
fly status --app reload-api        # Layer 1: one machine
# Fly dashboard Billing                # Layer 2: spend limit set + alert threshold
# Founder Console → infra budget       # Layer 3: ceiling configured, projection under it
```
