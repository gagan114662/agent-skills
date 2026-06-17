# ADR-0270: Analytics auto-install + read for Lens

- **Status:** Accepted (shipped in PR for #270)
- **Date:** 2026-06-17
- **Context issue:** [#270](https://github.com/gagan114662/agent-skills/issues/270) — Lens (the analytics
  department lead) cannot report until an analytics tag is on the site. With ipop-hosted pages the tag is
  injected automatically; for connected external sites ipop installs it through the site connector. Plus
  read access to GA4 / Plausible. **Acceptance:** traffic, signups, and conversions appear in the scorecard
  with no tag or code work by the user.
- **Builds on:** [ADR-0295](0295-deliverable-delivery.md) / [ADR-0294](0294-seo-page-one.md) (the
  default-OFF, owner-workspace-first feature-config + external-receipt patterns this copies),
  [ADR-0253](0253-proof-scorecard.md) (the founder-console proof scorecard — whose analytics tile this
  feeds), [ADR-0266](#) / #266 (ipop hosted publishing — the hosted-inject install path), #258 (the site
  connector — the external-inject path), [ADR-0267](0267-central-provisioning.md) (where a real vendor key
  lives, centrally), [ADR-0200](0200-premortem-panel.md) (the standing premortem this answers to).

## Context

The analytics department (Lens, #123) was wired into the blueprint, the contract, the skill docs, and the
proof scorecard, but its tile read only the internal #102 growth funnel — never the customer's actual site
analytics, because there was no analytics tag on the site and no read path. The blocker is install: a
customer should never paste a snippet or touch code.

## Decision

Add a self-contained, default-OFF analytics layer in new files (`src/analytics/*`, `routes/analytics.ts`,
`db/{schema,repositories}/analytics.ts`, migration `0270_analytics_install.sql`):

1. **Auto-install (structural, injection-safe).** `decideAnalyticsInstall` chooses the install path purely
   from how the site is hosted — `hosted_auto_inject` for an ipop-hosted page (#266), `connector_inject`
   for a connected external site (#258), `manual_pending` otherwise. It never reads page content (premortem
   #200 §6). `AnalyticsService.ensureInstalled` records the install idempotently (one `analytics_installs`
   row per workspace, keyed by `workspace_id`; re-install only writes when the snippet fingerprint changes).
   The console installs lazily on read, so the owner does zero work.

2. **Read (externally grounded, never fabricated).** The `AnalyticsProvider` seam returns a real reading or
   `null`. `dryrun` (the default) and a connected-but-unread vendor both return `null`, so the tile honestly
   says "awaiting first reading" rather than overclaim traffic (premortem #200 §2). `ga4` / `plausible` are
   the live shapes; the vendor key lives in the #192 / #267 vault, never in config.

3. **Scorecard wiring is strictly additive.** The analytics tile prefers the #270 reading when connected and
   otherwise falls back to today's #102 funnel reading — so an un-configured deployment (the default) is
   byte-for-byte unchanged, and a connected one gains real sessions / signups / conversions.

4. **Default OFF, owner-workspace-first** (mirrors `delivery` / `seo`): `resolveAnalyticsFlags` returns
   all-off unless `enabled` is true AND the workspace is the named owner workspace (or `ownerWorkspaceOnly`
   is explicitly false). Env (`RELOAD_ANALYTICS_*`) opts the owner workspace in without a managed.toml.

The `analytics_installs` table is deliberately `analytics_*`-prefixed (not `growth_*`/`venture_*`/`moat_*`/
`demand_*`) so the #155 colocation gate does not class it as a governed metric surface.

## Consequences

- Lens can report real site metrics with no owner tag/code work, the moment a read provider is connected.
- No regression while the layer is off: the funnel reading is preserved as the fallback.
- The live GA4 / Plausible HTTP read is a deliberate future ADR — the structure (provider selection,
  credential resolver, install record) is in place so activating it is a config change, not a rewrite.
