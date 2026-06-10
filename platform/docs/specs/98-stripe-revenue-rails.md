# Spec: Reload Platform — Stripe revenue rails (Issue #98)

> Implements [#98](https://github.com/gagan114662/agent-skills/issues/98). Lifecycle: **DEFINE**
> artifact (`spec-driven-development`). Builds on [#25](25-cloud-execution.md) (the per-tenant
> `SecretsResolver` + value redaction, the `*Provider` adapter seam, lazy SDK), [#73](41-deploy-to-live-url.md)
> (a manager **separate** from `SessionManager`, channel-bus events, a persisted immutable record,
> the egress gate, the trusted-config trust boundary), [#13](../adrs/0013-approval-gates.md) (sensitive
> actions gated for a human), [#71](40-cloud-scale.md) (the per-tenant usage dashboard surface), and
> [#9](09-registry-rbac.md) (the capability ladder + IDOR). Coordinates with **#96** (the venture
> scorecard) — this PR is **independent + additive**: it writes its own `revenue_evidence` table that
> #96's scorecard reads; it adds no dependency on #96's tables.

## ⚠️ Decision first — build vs. integrate
**Integrate Stripe behind a `BillingProvider` adapter; do not build a payments processor.** See
[ADR-0043](../adrs/0043-stripe-revenue-rails.md). This issue is scoped to *the revenue capability + the
adapter*, not to becoming a PSP. The first provider is **Stripe** (the official `stripe` npm SDK), loaded
behind a **lazy import**; the **default** provider is a no-network `NoneBillingProvider` that fully
exercises the surface so dev/CI/the demo never make a network call and never spend.

## Objective
**What:** From a FUNDed venture's deployed app (#73), **charge real money inbound** — create a product +
price and a payment link / checkout session, attach it to the deployment record + post it to the channel;
receive Stripe's **signature-verified, deduped** webhooks and persist a `revenue_events` row per
workspace; turn each real payment into **willingness-to-pay evidence** the venture scorecard (#96)
consumes; and surface **revenue per venture** on the #71 usage dashboard — all through a swappable
`BillingProvider` adapter.

**Why:** The platform can build and deploy apps to live URLs (#73) and will gate work on YC-fundability
(#96), but there is **no payment rail** — zero Stripe code in the repo. "An autonomous company that cannot
charge is a demo." This closes the gap so a venture's willingness-to-pay is proven by **real money in**,
the strongest possible signal — while keeping a hard safety rail around money **out**.

**Who:** A developer attached to a session (channel **write** capability) who wants that session's
deployed app to collect payment. Provider credentials are resolved server-side per tenant; the developer
supplies **no** secrets and **no** Stripe API call.

### Acceptance criteria (from #98)
1. **`billing/` module behind a `BillingProvider` seam** — `StripeProvider` (official `stripe` SDK, lazy)
   + `NoneProvider` **default** so dev/CI make **zero** network calls / spend.
2. **Secrets:** `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` per-tenant via the #25 `AGENT_SECRETS`
   path — never in config, never logged, redaction applies.
3. **Inbound capability:** create product + price and a payment link / checkout session for a deployed
   app; attach the link to the deployment record + post it to the channel.
4. **Webhook receiver** (`POST /billing/webhook/:wid`, **signature-verified**) → persist **deduped**
   `revenue_events` per workspace.
5. **Revenue feeds the Venture Loop (#96):** a real payment event becomes a `revenue_evidence`
   (willingness-to-pay) row the scorecard reads — built independent + additive.
6. **Hard safety rail:** outbound money (refunds / payouts / transfers) is **NEVER autonomous** — those
   are #13-approval-gated **sensitive actions** (like `external.send`), recorded-only in v1; payouts stay
   **manual in the Stripe dashboard**. The `BillingProvider` seam has **no outbound-money method** at all.
7. **Usage:** revenue per venture on the #71 usage surface.
8. `pnpm -C platform typecheck && lint && test` green; server integration green. Spec + ADR + migration
   (+down) + demo; one PR linking #98 with `Closes #98`. **Video gate waived by the owner.**

### In scope
- **`BillingProvider` adapter** (`apps/server/src/billing/provider.ts`) — a narrow, **inbound-only**
  interface: `createProductPrice(input) → ProductPrice`, `createPaymentLink(input) → PaymentLink`. There is
  deliberately **no** `refund`/`payout`/`transfer` method — outbound money is structurally absent from the
  seam. Two impls:
  - **`NoneBillingProvider`** (`billing/none-provider.ts`) — the **default**. Returns a deterministic
    `https://pay.none.reload.test/<slug>` link + synthetic product/price ids, records calls, and (like the
    #73 dry-run provider) emits a synthetic note that echoes the resolved secret so the **redaction test is
    real**. **Zero network, zero spend.**
  - **`StripeBillingProvider`** (`billing/stripe-provider.ts`) — the real adapter, the `stripe` SDK behind
    a **lazy `await import`** (optional dependency, never loaded in CI), gated by `BILLING_PROVIDER=stripe`;
    throws a helpful install/auth error if the SDK/key is missing.
  - **`createBillingProvider(env)`** (`billing/factory.ts`) selects by `env.billing.provider`, mirroring
    `createDeployProvider`/`createRuntime`.
- **Webhook signature verification** (`apps/server/src/billing/webhook.ts`) — a **pure**, SDK-free
  implementation of Stripe's signature scheme (`t=<ts>,v1=<hex-hmac-sha256(\`${t}.${rawBody}\`)>`) using
  `node:crypto`: `verifyWebhookSignature(rawBody, sigHeader, secret, { now, toleranceSec })` →
  throws `WebhookVerificationError` on a bad/forged signature **or** a timestamp outside the tolerance
  window (**replay protection**). Pure ⇒ exhaustively unit-tested; both providers + the manager use it, so
  verification is identical regardless of backend and needs no network.
- **Inbound-only safety guard** (`apps/server/src/billing/safety.ts`) — pure `isOutboundMoney(action)` +
  `assertInboundOnly(action)` (throws `OutboundMoneyBlocked`) over the
  `OUTBOUND_MONEY_ACTIONS = ["billing.refund","billing.payout","billing.transfer"]` set, so any future
  caller that tries to move money out through the manager fails closed.
- **`BillingManager`** (`apps/server/src/billing/manager.ts`) — orchestrates the two inbound flows. Every
  dependency is an injectable with a real default (the #73 testability seam):
  - `createPaymentLink(req)` — `egressAllowed` gate → `NoBillingConfigError` if the tenant has no `billing`
    section → resolve secrets (per workspace) → `makeRedactor` → `provider.createProductPrice` +
    `provider.createPaymentLink` (carrying `{ workspaceId, channelId, sessionId, deploymentId }` as
    **metadata** so the webhook can close the loop) → persist an immutable `payment_links` row **attached to
    the session's latest deployment** → post `💳 Pay here: <url>` into the channel → publish
    `billing_status`. Any provider error is **redacted** before it is persisted/streamed.
  - `ingestWebhook(workspaceId, rawBody, signature)` — resolve the tenant's `STRIPE_WEBHOOK_SECRET` →
    `verifyWebhookSignature` (throws → 400) → parse → **dedupe** on `(workspace_id, provider_event_id)`
    (a replayed event id is a no-op that returns the existing row) → persist a `revenue_events` row (raw
    payload **redacted**) → on a successful-payment event, persist a `revenue_evidence`
    (`willingness_to_pay`) row → best-effort post `💰 Received <amount>` to the originating channel (from
    the event metadata) + publish `billing_status`.
- **Persistence.** Three workspace-scoped tables (`db/schema/revenue.ts`, repo `db/repositories/billing.ts`,
  migration `apps/server/drizzle/0098_stripe_revenue_rails.sql` + `.down.sql`):
  - `payment_links` — `id, workspace_id, channel_id, session_id, deployment_id?, provider, product_id,
    price_id, provider_link_id, url, amount_cents, currency, interval, created_by_member_id, created_at`.
    Immutable; the `deployment_id` FK **is** the attach-to-deployment link.
  - `revenue_events` — `id, workspace_id, channel_id?, session_id?, deployment_id?, provider, provider_event_id,
    type, amount_cents, currency, status, raw (redacted jsonb), created_at`. **Unique** `(workspace_id,
    provider_event_id)` ⇒ webhook idempotency. Workspace-scoped reads (IDOR).
  - `revenue_evidence` — `id, workspace_id, session_id?, kind ('willingness_to_pay'), source ('revenue'),
    revenue_event_id, amount_cents, currency, summary, created_at`. The **additive seam #96's scorecard
    reads** — independent of any #96 table.
- **Realtime.** One new `ServerEvent` variant `billing_status` on the existing channel bus (no gateway
  change, like #73): `link_created(url) | payment_received(amount)`. Published via `publishBillingEvent` in
  `realtime/bus.ts`; mirrored in `packages/shared` for the web client.
- **REST routes** (`apps/server/src/routes/billing.ts`):
  - `POST /channels/:cid/agent-sessions/:id/billing/payment-link` — channel **write** + channel-scoped
    `getAgentSession` (IDOR-safe). Body: bounded `{ name, amountCents, currency?, interval? }` (product +
    price; never a Stripe call from the client). → `201 { paymentLink }`. `409` when the tenant has no
    `billing` config or under data-privacy mode.
  - `POST /billing/webhook/:wid` — **unauthenticated** (Stripe calls it) but **signature-verified**; reads
    the **raw body** (a plugin-scoped buffer content-type parser, encapsulated to this one route). →
    `200 { received: true, deduped }` on a valid signature, `400` on a bad/forged/replayed signature.
  - `GET /workspaces/:wid/billing/revenue` — tenant-scoped (`assertWorkspace`, like the #71 usage route):
    `{ currency, totalCents, paymentCount, evidenceCount, recent[] }` — **revenue per venture** for the
    usage dashboard.
- **Config.** A `billing` section in the layered schema (`config/schema.ts`): `{ provider?
  ('none' | 'stripe'), currency? ('usd' default), secretKeyName? ('STRIPE_SECRET_KEY'),
  webhookSecretName? ('STRIPE_WEBHOOK_SECRET') }`. **Trusted (repo/managed scope), never request-supplied**
  — the #73/#27 trust boundary; it carries only secret-var **names**, never values. Absent `billing` section
  ⇒ the inbound routes `409` (the tenant opted out).
- **Env.** `BillingEnv` (`env.ts`): `provider` (`none` default | `stripe`), `webhookToleranceSeconds`
  (default 300 — Stripe's recommended replay window).
- **Outbound-money safety wiring.** `billing.refund` / `billing.payout` / `billing.transfer` are added to
  the #13 `DEFAULT_SENSITIVE_ACTIONS` (gated by default); `billing.refund` is wired as a **recorded-only**
  approval executor (the `external.send` pattern — **no Stripe call even after a human approves** in v1).

### Out of scope (deferred / documented-not-automated)
- **Becoming a PSP / building a payments processor** (ledgers, reconciliation, dispute handling, KYC) —
  Stripe owns that; we integrate.
- **Real outbound money** (refunds / payouts / transfers executed against Stripe). v1 gates them as #13
  sensitive actions and **records the intent only**; payouts stay **manual in the Stripe dashboard**. Wiring
  a real `stripe.refunds.create` behind the approval gate is a deliberate, separate follow-up.
- **A second billing provider** (Paddle / Lemon Squeezy), **Stripe Connect / multi-account marketplaces**,
  **tax / invoicing**, **subscription lifecycle management** (upgrades/cancels/proration beyond recording
  the events), and the **web Billing tab** (the channel post + `billing_status` event are the v1 UI; a
  dedicated panel is a follow-up like #73's was).
- **Auto-triggering a payment link from the #73 deploy event.** The deploy attach **seam** is in place
  (`payment_links.deployment_id`); v1 ships the explicit `payment-link` endpoint and the demo drives it.

## The revenue model
```
BillingProvider (INBOUND ONLY — no refund/payout/transfer method exists)
  createProductPrice({ name, amountCents, currency, interval, secrets }) -> { productId, priceId }
  createPaymentLink ({ priceId, slug, metadata, secrets })               -> { providerLinkId, url }

BillingManager (persisted; per-session + per-workspace history)
  createPaymentLink({ sessionId, workspaceId, channelId, agentMemberId, createdByMemberId,
                      name, amountCents, currency?, interval? }) -> PaymentLink
    cfg = loadConfig(workspaceId)
    if !cfg.billing                 -> throw NoBillingConfigError   (route → 409)
    if !egressAllowed(cfg)          -> throw BillingEgressBlocked   (route → 409, off-platform egress)
    secrets = secretsResolver.resolve(workspaceId)        // STRIPE_SECRET_KEY (name from cfg)
    redact  = makeRedactor(secrets)
    deploymentId = deployments.latestForSession(...)      // attach to the deployment record
    pp   = provider.createProductPrice({ name, amountCents, currency, interval, secrets })
    link = provider.createPaymentLink({ priceId: pp.priceId, slug, secrets,
             metadata: { workspaceId, channelId, sessionId, deploymentId } })   // closes the webhook loop
    row  = store.createPaymentLink({ ...pp, ...link, deploymentId, amountCents, currency, interval })
    post(channel, `💳 Pay here: ${link.url}`);  publish(billing_status link_created)
    return row

  ingestWebhook(workspaceId, rawBody, signature) -> { event?, deduped }
    secret = secretsResolver.resolve(workspaceId)[cfg.billing.webhookSecretName]  // STRIPE_WEBHOOK_SECRET
    verifyWebhookSignature(rawBody, signature, secret, { now, toleranceSec })     // throws → route 400
    parsed = parsePayload(rawBody)                                                // id, type, amount, currency, metadata
    if revenue_events has (workspaceId, parsed.id) -> return { deduped: true }    // idempotent replay
    ev = store.createRevenueEvent({ ...parsed, raw: redact(rawBody) })
    if isSuccessfulPayment(parsed.type):
        store.createEvidence({ kind: "willingness_to_pay", source: "revenue", revenueEventId: ev.id, ... })
        if parsed.metadata.channelId: post(channel, `💰 Received ${amount}`); publish(billing_status payment_received)
    return { event: ev, deduped: false }
```
**Why a separate manager.** Exactly the #73 argument: a billing flow is neither a harness run nor a dev
server; it is a durable, off-platform, credential-bearing job whose record must survive a restart. Keeping
it off `SessionManager` keeps the blast radius off the safety-critical run path while reusing the proven
secrets + redaction + egress + channel-post primitives.

## Security
- **Inbound money only — enforced structurally.** The `BillingProvider` interface has **no** outbound-money
  method; the manager has no path that moves money out. `assertInboundOnly` fails closed on
  `refund`/`payout`/`transfer`. Outbound money is a #13 sensitive action, **recorded-only** in v1 (no Stripe
  call even after a human approval), and payouts stay manual in the Stripe dashboard.
- **Per-tenant secrets, never logged.** `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` live ONLY on the #25
  `SecretsResolver` path keyed by workspace (config holds the var **names** only). Every provider error and
  the stored webhook `raw` payload pass through `makeRedactor(secrets)`, so a key value can never appear in a
  `billing_status` event, the `revenue_events.raw` column, a `payment_links` row, the channel message, or a
  log line. The secret map itself is never logged. (The #25 guarantee, reused.)
- **Signature-verified, replay-resistant webhooks.** The receiver verifies Stripe's HMAC-SHA256 signature
  over the **raw** body with the tenant's webhook secret and rejects a timestamp outside the tolerance
  window — a forged or replayed delivery is a `400`, never a persisted event. Idempotency is enforced again
  at the DB via the unique `(workspace_id, provider_event_id)` index, so even a duplicate **valid** delivery
  creates at most one row.
- **Off-platform egress gate.** Creating a Stripe object is off-platform egress, so `createPaymentLink`
  calls `egressAllowed(cfg)` first and refuses (`409`) under `dataPrivacyMode` — the same gate #73 honors.
- **IDOR-safe + RBAC.** The payment-link route resolves the session via channel-scoped
  `getAgentSession(id, cid)` and requires **channel write**; the revenue route is `assertWorkspace`-scoped;
  the webhook is workspace-scoped by `:wid` and gated solely by the signature. A cross-tenant session/channel
  is a `404` (invisible). `revenue_events`/`payment_links`/`revenue_evidence` reads are workspace-scoped.
- **Bounded payloads.** `name` is length-capped, `amountCents` is a positive bounded integer, `currency` is
  a 3-letter code, `interval` is an enum — a channel writer cannot create an arbitrary or unbounded charge.

## Testing strategy
- **Unit (hermetic, no DB / no network — `pnpm test`):**
  - **`verifyWebhookSignature`:** a payload signed with the secret verifies; a tampered body / wrong secret
    / malformed header throws; a timestamp older than the tolerance throws (**replay**); a freshly-signed
    one passes. Deterministic via an injected `now`.
  - **`BillingManager` with the `NoneBillingProvider` + an in-memory store** (copy `deploy-manager.test.ts`):
    - `createPaymentLink` → a `https://…` link; a `💳 Pay here: <url>` message posted; `billing_status`
      published; the row carries the session's latest `deploymentId` (**attached to the deployment**).
    - **secret redaction:** the secret the provider echoes never appears in any published event, the stored
      `raw`, or the channel message — only the mask; a forced provider error is redacted too.
    - **webhook → revenue event → evidence:** a signed event ingests to a `revenue_events` row **and** a
      `revenue_evidence` (`willingness_to_pay`) row; a channel `💰 Received …` is posted.
    - **dedupe / replay:** re-ingesting the **same** event id returns `{ deduped: true }` and creates no new
      row; a bad signature throws `WebhookVerificationError` (no row).
    - **egress:** `dataPrivacyMode` on ⇒ `createPaymentLink` throws `BillingEgressBlocked` (no provider call).
    - **opt-in:** no `billing` config ⇒ `NoBillingConfigError`.
  - **inbound-only enforcement:** `assertInboundOnly("billing.refund")` throws `OutboundMoneyBlocked`;
    `assertInboundOnly("billing.create_payment_link")` passes; the `BillingProvider` type has no
    outbound-money member (a compile-time guard test); `evaluatePolicy({actionType:"billing.refund"}, [])`
    is **gated** (sensitive by default), and the wired `billing.refund` executor is **recorded-only** (no
    network).
  - **`createBillingProvider`:** `none` (default) → `NoneBillingProvider`; `stripe` →
    `StripeBillingProvider` (constructed, SDK **not** loaded — lazy); an injected provider wins.
- **Integration (real Postgres/Redis, none provider — `pnpm test:integration`, copy `deploy.test.ts`):**
  `buildApp({ billingManager })` over the none provider. `POST …/billing/payment-link` → `201` with a
  `https://…` url; a `💳 Pay here` **message** persisted in the channel; the `payment_links` row references
  the session's deployment. Then `POST /billing/webhook/:wid` with a **validly-signed** synthetic event →
  `200`, a `revenue_events` row + a `revenue_evidence` row appear, a `💰 Received …` message is posted, and
  `GET /workspaces/:wid/billing/revenue` shows the total + evidence count. A **second** delivery of the same
  event id → `200 { deduped: true }`, still one row. A **bad signature** → `400`, no row. A workspace secret
  never appears in `revenue_events.raw`. Cross-channel payment-link → `404` (IDOR). No `billing` config →
  `409`.

## Boundaries
- **Always:** keep billing off `SessionManager`; take provider config from trusted config only; resolve
  secrets per tenant and redact every error + stored raw payload + channel message; verify the webhook
  signature over the raw body and reject outside the tolerance window; dedupe on `(workspace, event id)`;
  gate the payment-link route on channel write + channel-scoped session; call `egressAllowed` before any
  provider call; default provider = no-network `none` with the real Stripe SDK behind a lazy import; write
  the failing test first.
- **Ask first:** flipping the default provider to `stripe` org-wide; executing a **real** refund/payout/
  transfer (even behind the approval gate); a second provider; Stripe Connect; a request-supplied
  product/price.
- **Never:** build a payments processor; add an outbound-money method to the `BillingProvider` seam; make an
  autonomous refund/payout/transfer; let a secret reach a log/event/row/message; persist an unverified
  webhook; charge under data-privacy mode; cross a channel/workspace boundary.

## Success criteria
1. From a session, `POST …/billing/payment-link` returns a live `https://…` payment URL that is posted into
   the channel and attached to the deployment record (integration).
2. A signature-verified webhook persists exactly one deduped `revenue_events` row + a `revenue_evidence`
   (`willingness_to_pay`) row; a replayed event id is a no-op; a forged signature is rejected (unit +
   integration).
3. A workspace secret never appears in any billing event, error, stored payload, or channel message (unit +
   integration); a payment link under data-privacy mode is refused.
4. Outbound money is gated as a #13 sensitive action and is recorded-only — no autonomous Stripe call exists
   (unit); the `BillingProvider` seam has no outbound-money method.
5. `GET …/billing/revenue` surfaces revenue per venture for the #71 dashboard (integration).
6. `pnpm -C platform typecheck && lint && test` green; integration green. ADR-0043 + this spec + migration
   `0098` (+down) + demo; PR links #98 with `Closes #98`. **Video gate waived by the owner.**

## Plan (atomic)
1. **ADR-0043** integrate-Stripe + inbound-only safety rail — *DEFINE* (this commit).
2. **Pure seam + verification + safety:** `billing/provider.ts`, `billing/webhook.ts` (pure signature),
   `billing/safety.ts`, `billing/none-provider.ts`, `billing/stripe-provider.ts` (lazy), `billing/factory.ts`
   — *slice 1* (verification + factory + safety tests first).
3. **Manager + persistence + config + realtime:** `billing/manager.ts` (+ `billing/default.ts`),
   `db/schema/revenue.ts` + repo + migration `0098`, the `billing` config section, `billing_status` +
   `publishBillingEvent`, shared DTOs, `BillingEnv`, the #13 outbound sensitive action + recorded-only
   executor — *slice 2* (manager test first).
4. **Routes + wiring:** `routes/billing.ts` (payment-link / webhook / revenue) + register in `app.ts` —
   *slice 3* (integration test first).
5. ADR + demo + PR linking #98 (`Closes #98`) — *ship*. **Video gate waived by the owner.**

> Approach: defaults-and-go per the maintainer's mandate (DEFINE → PLAN → BUILD with TDD → demo → PR). The
> owner has **waived the video gate** for this issue; the demo script is still committed for reproducibility.
