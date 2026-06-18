# ADR-0272 — Ads: one-click account connect, money-gated spend, graceful creative review

- Status: Accepted
- Issue: #272
- Depends on / reuses: #258 (connect-once), #267/#243/#13 (money gate), #189 (acquisition envelope), #200 (premortem)
- Date: 2026-06-18

## Context

Bid (the `ads` department, `marketing/blueprint.ts`) drafts campaigns but has had no way to (a) connect a
real ad account, (b) release real spend safely, or (c) report honestly on platform creative review. The
premortem (#200) is the binding constraint: ad spend is IRREVERSIBLE money (§4) — yesterday's spend can't be
refunded — so it must be HARD-gated and pre-committed; campaign/spend state must be READ BACK from the
provider, never assumed (§3); and any externally-sourced creative/review content is untrusted (§6).

Almost every seam already exists. The decision is to **reuse**, not invent:

- **Connect** rides the #258 connect-once OAuth seam (descriptor → gated live flow → #192 vault).
- **Spend** rides the existing `provisioning.customer_spend` MONEY action (#267/#243) — **no new money action**
  is introduced (the `approval-policy.test` MONEY set is pinned and stays untouched).
- **Creative review** reuses the #267 provider-response quarantine (`sanitizeProviderText`).

## Decision

A new pure-first `ads/` module + a thin route/service, all **default-OFF, owner-workspace-first**.

1. **One-click connect** — add a single customer-facing OAuth `ConnectionDescriptor` (`google_ads`, kind
   `ad_account`, capability `ads`, scope `adwords`). It renders today as the honest `coming_soon` stub (no
   live OAuth client is wired in this slice; nothing real is minted — #200 §3). Bid gates its work on the
   existing `hasConnectedCapability({ capability: "ads" })`.

2. **Money-gated spend with a hard cap** (`ads/spend.ts`, pure). EVERY spend / budget-raise / launch is a #13
   money-gated owner yes with the EXACT amount shown (`provisioning.customer_spend`). There is **no
   autonomous-spend path** — the only outcome for a positive spend is `needs_approval`. A request OVER the
   configured hard per-action cap (`ads.perActionCapCents`) is REFUSED outright (`blocked`) — not even
   approvable through the agent path; the owner must raise the cap in config. This is the ceiling **the system
   never crosses** (premortem §4: bounded blast radius, pre-committed). An undetermined (non-finite) or invalid
   (negative / non-integer) cost is `blocked` (never spend on uncertainty, #243). Two independent OFF switches:
   the feature flag and the cap (default 0 ⇒ no spend approvable until the owner sets it).

   On approval the existing-action gap is closed: a **recorded-only** `provisioning.customer_spend` executor
   (`{recorded:true, executed:false}`) is registered, so a money-gated ad spend resolves cleanly instead of
   failing "no executor". A live ad-API spend behind the gate is a deliberate follow-up — never autonomous.

3. **Graceful creative review** (`ads/creative-review.ts`, pure). The platform's review state — read back from
   the API — is normalized to an honest, fail-closed status (`approved` / `rejected` / `pending_review` /
   `limited` / `unknown`). Only `approved`/`limited` may serve; everything else (including an unrecognized
   state and a delayed-but-pending review) cannot serve and blocks spend. The platform's free-text rejection
   reason is sanitized (`sanitizeProviderText`) before it is ever surfaced (#200 §6).

4. **Read-back, never assume** (`ads/provider.ts`). An `AdsProvider` seam reads back campaign + spend state;
   the `DryRunAdsProvider` production default reads back NOTHING (honest "not connected"). Responses are
   quarantined as inert DATA and the spend total is DERIVED from the line items, not the provider's claimed
   total (#200 §3/§6).

5. **Surface** — `AdsService.status` (honest connected/account/review state) + `AdsService.requestSpend` (park
   the money-gated approval), exposed at `GET /me/ads` and `POST /me/ads/spend`. Requires a connected account
   before any spend.

## Why a dedicated per-action gate (not the #189 autonomous envelope)

The #189 acquisition envelope lets optimizations spend AUTONOMOUSLY against an owner-approved cap. For Bid we
deliberately choose the stricter model the premortem directive demands: **every** spend is a fresh owner yes
with the exact amount, bounded by a hard config ceiling. Money is irreversible; a per-action human gate is the
safest pre-commitment.

## Config (new block — 5 + 2 + 1)

`ads` block in `config/schema.ts` (schema + settings + type + ResolvedConfig + defaults), `config/layers.ts`
(replace + default fallback), `config/loader.ts` (`RELOAD_ADS_ENABLED` / `RELOAD_ADS_OWNER_WORKSPACE_ID` /
`RELOAD_ADS_PER_ACTION_CAP_CENTS`, owner reuses the #258 `RELOAD_MARKETING_OWNER_WORKSPACE_ID` marker).

## Consequences

- No new money action; the #243 MONEY set and its test are unchanged.
- No migration: campaign/spend state is read back from the provider; the approved cap rides the #13 payload.
- Default OFF + cap 0 + dry-run provider ⇒ a deployment that sets nothing offers no spend path and connects
  nothing. Live connect / live ad-API spend stay owner-gated follow-ups. **No real money is ever spent and no
  live billing/ad account is connected by this change — build + PR only.**
