# Billing go-live checklist (#481)

How to take ipop billing from **test mode** to **live** — charging real paying customers. The full revenue
path (checkout → signed webhook → plan activation → usage caps) is already wired and tested on the
no-network `none` provider; going live is a deliberate, owner-only config flip with a fail-closed guardrail.

> The agent never performs these steps. Live key material and the `BILLING_MODE=live` flip are
> **owner-gated** — set them yourself on the host (e.g. Fly secrets). The repo contains **zero** key
> material; `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` are only **names** on the #25 secrets path.

## How it works

Two orthogonal switches:

| Env var            | Values            | Default | Meaning                                              |
| ------------------ | ----------------- | ------- | ---------------------------------------------------- |
| `BILLING_PROVIDER` | `none` \| `stripe`| `none`  | Which backend collects money (`none` = no network).  |
| `BILLING_MODE`     | `test` \| `live`  | `test`  | Declared intent. Only `live` takes real money.       |

Real money is on **iff** `BILLING_PROVIDER=stripe` **and** `BILLING_MODE=live`. The Stripe adapter asserts
the supplied key's prefix matches `BILLING_MODE` **before** any network call and **fails closed** on a
mismatch (`BillingModeMismatchError`):

- `BILLING_MODE=live` + a `sk_test_…` key → refuses to start (would silently take **no** real money).
- `BILLING_MODE=test` + a `sk_live_…` key → refuses to start (would charge **real** cards).

The `GET /workspaces/:wid/billing/status` endpoint returns `{ provider, mode, live }`, and the
Settings → Billing panel renders the real state — "Live — real payments are on" vs "Test mode".

## Pre-flight (still in test mode)

- [ ] Verify the full path on **test** keys: `BILLING_PROVIDER=stripe`, `BILLING_MODE=test`, a
      `sk_test_…` key + `whsec_…` test webhook secret. Run a checkout with a
      [Stripe test card](https://stripe.com/docs/testing) (`4242 4242 4242 4242`) and confirm the webhook
      activates the plan and the revenue shows in the usage dashboard.
- [ ] Confirm the live Stripe account is activated (business details, bank account for payouts) and that
      the webhook endpoint `POST https://<api-host>/billing/webhook/<workspaceId>` is registered in the
      **live** Stripe dashboard for `checkout.session.completed`.
- [ ] Confirm the prices in `billing/plans.ts` (Starter $49 / Pro $199 / Agency $499) are what you intend
      to charge — this catalog is the single source of truth for the page **and** the Stripe products.

## Flip to live (owner runs these — never committed, never the agent)

```sh
# 1. Live key material (names only live in the repo; values live only in host secrets).
fly secrets set STRIPE_SECRET_KEY=sk_live_…    --app reload-api
fly secrets set STRIPE_WEBHOOK_SECRET=whsec_…  --app reload-api   # the LIVE webhook signing secret

# 2. Turn the rails on and declare go-live.
fly secrets set BILLING_PROVIDER=stripe         --app reload-api
fly secrets set BILLING_MODE=live               --app reload-api

# 3. Mint the real live products/prices once (idempotent — a second run is a no-op).
fly ssh console --app reload-api -C "pnpm -C platform/apps/server billing:bootstrap <workspaceId>"
```

If the key and `BILLING_MODE` disagree, the server fails closed at the first billing call — fix the key or
the mode and redeploy.

## Verify the first real payment

- [ ] `GET /workspaces/<wid>/billing/status` returns `{ "provider": "stripe", "mode": "live", "live": true }`.
- [ ] Settings → Billing shows **"Live — real payments are on"** (not the test-mode note).
- [ ] Run **one real** checkout (a real card, smallest plan), confirm the charge in the **live** Stripe
      dashboard, confirm the signed webhook activated the plan, and refund that first charge from the
      dashboard once verified.

## What stays manual / out of scope

- **Flipping the live keys + `BILLING_MODE=live`** — owner-gated, above. The agent never does this.
- **Payouts and refunds** — outbound money is structurally absent from the billing seam and is a #13
  approval-gated, recorded-only action; do them in the Stripe dashboard.
- **Stripe account activation, tax/Stripe Tax, disputes/chargebacks** — owned in the Stripe dashboard.

## Rollback

Set `BILLING_MODE=test` (or `BILLING_PROVIDER=none`) and redeploy. No real charges occur; the UI reverts to
the test-mode note. Live keys can stay set — `BILLING_MODE=test` with a live key fails closed, so nothing
charges until you deliberately flip back.
