# Outbound Email Runbook

Issue #395 closes only when ipop can reach a real stranger through one live outbound channel and record a
production readback receipt. Postmark was the first channel; Resend is also supported.

## Doctor

Run the safe setup doctor from the repo root:

    pnpm -C platform --filter @reload/server outbound:doctor

The doctor reports missing env vars by name only, verifies the selected provider identity, verifies
acquisition email live-send flags, verifies CAN-SPAM footer config, and skips real sends by default. It uses
`RELOAD_ACQUISITION_ESP_PROVIDER`, then `RELOAD_REACH_SEND_PROVIDER`, then Postmark as the default. To prove a
specific provider before flipping live-send env, pass `--provider postmark` or `--provider resend`:

    pnpm -C platform --filter @reload/server outbound:doctor -- --provider resend

Postmark identity is checked with the official `/server` endpoint. Resend identity is checked with the
official `/domains` endpoint. Neither path sends an email unless `--send-smoke` is also provided.

To send an explicit tagged smoke email:

    pnpm -C platform --filter @reload/server outbound:doctor -- --provider resend --send-smoke --to owner@example.com --subject "ipop outbound smoke" --text "ipop outbound smoke"

Only run --send-smoke against an owner-controlled recipient until suppression, approval, and first-customer
proof are being intentionally exercised.

To turn an approved real send into queryable #395/#908 evidence, include the workspace and #13 approval id:

    pnpm -C platform --filter @reload/server outbound:doctor -- --send-smoke --to buyer@realcompany.com --workspace-id <workspace-id> --approval-request-id <approval-request-id> --tracking-ref <tracking-ref> --proof-json

With those ids present, the doctor records the provider message id as a verified production_readback row in
outbound_send_receipts and prints the outboundDelivery JSON block that the first-customer proof file expects.
The `trackingRef` must match the prospect import, routed inbound lead, and booking/trial link in the
first-customer proof. In `--proof-json` mode, the doctor refuses to send unless `--workspace-id`,
`--approval-request-id`, and `--tracking-ref` are all present. Without those ids, run a plain smoke send
only; it can prove Postmark reachability but cannot close the irreversible-send approval requirement.

## Required Production Env

Postmark:

- POSTMARK_SERVER_TOKEN
- POSTMARK_FROM or POSTMARK_FROM_ADDRESS or POSTMARK_SENDER

Resend:

- RESEND_API_KEY
- RESEND_FROM or RESEND_FROM_ADDRESS or RELOAD_FLEET_FROM_EMAIL

Live acquisition email:

- RELOAD_REACH_SEND_PROVIDER=postmark or resend
- RELOAD_REACH_LIVE_SEND_ENABLED=1
- RELOAD_ACQUISITION_ENABLED=true
- RELOAD_ACQUISITION_EMAIL=true
- RELOAD_ACQUISITION_ESP_PROVIDER=postmark or resend
- RELOAD_ACQUISITION_BRAND_NAME
- RELOAD_ACQUISITION_POSTAL_ADDRESS
- RELOAD_ACQUISITION_UNSUBSCRIBE_URL

## Proof Before Closure

- outbound:doctor passes config, provider identity, and compliance checks.
- outbound:doctor -- --send-smoke sends a tagged email to a non-example recipient, returns a provider
  message id, and records it with --workspace-id plus --approval-request-id plus --tracking-ref.
- A real approved acquisition send records the provider message id as a production_readback receipt in
  outbound_send_receipts.
- The larger #908 path then needs a real non-example prospect, visible reply or routed inbound lead, and a
  booking/trial link before "first real customer" is closed.
