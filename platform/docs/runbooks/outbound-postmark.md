# Outbound Postmark Runbook

Issue #395 closes only when ipop can reach a real stranger through one live outbound channel and record a
production readback receipt. Postmark is the first channel.

## Doctor

Run the safe setup doctor from the repo root:

    pnpm -C platform --filter @reload/server outbound:doctor

The doctor reports missing env vars by name only, verifies the Postmark server token with the official
Postmark /server endpoint, verifies acquisition email live-send flags, verifies CAN-SPAM footer config, and
skips real sends by default.

To send an explicit tagged smoke email:

    pnpm -C platform --filter @reload/server outbound:doctor -- --send-smoke --to owner@example.com --subject "ipop outbound smoke" --text "ipop outbound smoke"

Only run --send-smoke against an owner-controlled recipient until suppression, approval, and first-customer
proof are being intentionally exercised.

To turn an approved real send into queryable #395/#908 evidence, include the workspace and #13 approval id:

    pnpm -C platform --filter @reload/server outbound:doctor -- --send-smoke --to buyer@realcompany.com --workspace-id <workspace-id> --approval-request-id <approval-request-id> --tracking-ref <tracking-ref> --proof-json

With those ids present, the doctor records the Postmark MessageID as a verified production_readback row in
outbound_send_receipts and prints the outboundDelivery JSON block that the first-customer proof file expects.
The `trackingRef` must match the prospect import, routed inbound lead, and booking/trial link in the
first-customer proof. Without the approval id, a smoke send can prove Postmark reachability but cannot close
the irreversible-send approval requirement.

## Required Production Env

- POSTMARK_SERVER_TOKEN
- POSTMARK_FROM or POSTMARK_FROM_ADDRESS or POSTMARK_SENDER
- RELOAD_ACQUISITION_ENABLED=true
- RELOAD_ACQUISITION_EMAIL=true
- RELOAD_ACQUISITION_ESP_PROVIDER=postmark
- RELOAD_ACQUISITION_BRAND_NAME
- RELOAD_ACQUISITION_POSTAL_ADDRESS
- RELOAD_ACQUISITION_UNSUBSCRIBE_URL

## Proof Before Closure

- outbound:doctor passes config, Postmark server identity, and compliance checks.
- outbound:doctor -- --send-smoke sends a tagged email to a non-example recipient, returns a Postmark
  MessageID, and records it with --workspace-id plus --approval-request-id plus --tracking-ref.
- A real approved acquisition send records the Postmark MessageID as a production_readback receipt in
  outbound_send_receipts.
- The larger #908 path then needs a real non-example prospect, visible reply or routed inbound lead, and a
  booking/trial link before "first real customer" is closed.
