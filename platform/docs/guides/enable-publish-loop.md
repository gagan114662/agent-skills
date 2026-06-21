# Enabling the production→publish loop on the owner workspace (#438)

This is the **owner runbook** for turning ipop's marketing fleet from "audit + draft for review" into
"write + publish a real on-site asset on a cadence" (#415/#416/#437 → the #367 DoD). Everything below is
**default-OFF**; with the vars unset, prod is byte-for-byte unchanged. It is **owner-gated** — these flags
enable real outbound publishing, so a human runs them (the agents only PREPARE drafts; every ship still
passes the #13 approval gate).

> All flags are deployment **env vars** read by `config/loader.ts` `envLayer` (no `managed.toml` needed).
> On Fly: `flyctl secrets set KEY=value -a reload-api` (a deploy restarts the app with the new config).
> A higher `managed.toml` layer, if present, still wins as the lock.

## The chain (already built + verified)
`content-cadence brief (#437)` → fleet drafts → `agent.deliverable` card in the **#13** queue → owner
approves → `delivery` routes the SEO/content draft to the **`site_pr`** channel (#364) → the **GitHub
site-PR actuator** (#250) opens a real on-site content PR → durable receipt + **#386 attribution**.

## Step 1 — dry-run first (no real PR yet)
Turn on delivery + the cadence, but **leave the live site-PR provider unset** so `site_pr` runs as a
dry-run (`live:false`, no PR opened). This proves the brief→draft→approve path end to end safely.

```sh
flyctl secrets set -a reload-api \
  RELOAD_MARKETING_OWNER_WORKSPACE_ID=<owner-workspace-id> \
  RELOAD_DELIVERY_ENABLED=true \
  RELOAD_DELIVERY_SITE_PR=true \
  RELOAD_CONTENT_CADENCE_ENABLED=true \
  RELOAD_CONTENT_CADENCE_QUERIES="best ai marketing agent,autonomous marketing software,ai seo tool" \
  CONTENT_CADENCE_INTERVAL_MS=3600000
# Owner scope falls back to RELOAD_MARKETING_OWNER_WORKSPACE_ID for both blocks; set
# RELOAD_DELIVERY_OWNER_WORKSPACE_ID / RELOAD_CONTENT_CADENCE_OWNER_WORKSPACE_ID to override.
```

Verify the cadence brief fires (within one tick) and a deliverable lands in the #13 queue; approve it and
confirm the dispatcher recorded a dry-run ship (`live:false`) — no PR yet.

## Step 2 — go live (real on-site PR)
Point the site-PR provider at the real repo. The GitHub token is a **secret** (never config) read at
publish time.

```sh
flyctl secrets set -a reload-api \
  RELOAD_REALWORLD_ENABLED=true \
  RELOAD_REALWORLD_SITE_PR_PROVIDER=github \
  RELOAD_REALWORLD_SITE_REPO=<org/ipop-site-repo> \
  RELOAD_REALWORLD_SITE_CONTENT_DIR=content/blog \
  GITHUB_TOKEN=<repo-scoped-token>   # secret; used only at publish time, never logged/returned
```

## Step 3 — verify the real ship (#200 §3, no asserted success)
1. A cadence brief or owner brief produces a draft → approve it at the #13 gate.
2. Confirm a **real PR url** is opened against the site repo and answers **HTTP 2xx** (the adapter's
   `headCheck` read-back; the receipt records `live:true` only then).
3. Confirm the #386 attribution exposure row for the shipped artifact.

## Rollback (reversible, money-free)
Unset the flags and redeploy — the fleet returns to acknowledgement-only:
```sh
flyctl secrets unset -a reload-api \
  RELOAD_DELIVERY_ENABLED RELOAD_DELIVERY_SITE_PR \
  RELOAD_CONTENT_CADENCE_ENABLED RELOAD_REALWORLD_SITE_PR_PROVIDER
```
An already-opened content PR is itself reversible (close it; merge/deploy was always a separate human
action). No money moves at any step — `site_pr` is a review surface, not a spend.

## Flag reference
| Block | Env var | Effect |
|---|---|---|
| delivery (#295) | `RELOAD_DELIVERY_ENABLED` | master switch for approve→publish ship |
| delivery | `RELOAD_DELIVERY_SITE_PR` | route content/SEO deliverables to the `site_pr` channel (#364) |
| delivery | `RELOAD_DELIVERY_OWNER_WORKSPACE_ID` | owner-first scope (falls back to the #258 marketing owner) |
| realworld (#231/#250) | `RELOAD_REALWORLD_SITE_PR_PROVIDER=github` | select the live GitHub site-PR provider (unset ⇒ dry-run) |
| realworld | `RELOAD_REALWORLD_SITE_REPO` | the site repo the PR is opened against |
| realworld | `RELOAD_REALWORLD_SITE_CONTENT_DIR` | content dir (default `content/blog`) |
| contentCadence (#416/#437) | `RELOAD_CONTENT_CADENCE_ENABLED` | master switch for the timed content-brief loop |
| contentCadence | `RELOAD_CONTENT_CADENCE_QUERIES` | comma-separated editorial calendar (target queries) |
| contentCadence | `RELOAD_CONTENT_CADENCE_OWNER_WORKSPACE_ID` | owner-first scope (falls back to the #258 marketing owner) |
| contentCadence | `CONTENT_CADENCE_INTERVAL_MS` | tick interval (0 = off; e.g. `3600000` = hourly check, one brief/day) |
