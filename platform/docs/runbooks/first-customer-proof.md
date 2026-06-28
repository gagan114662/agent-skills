# First Customer Proof Runbook

Issue #908 closes only when a clean deployment proves the whole first-customer spine with real external
evidence: source, send, reply, route, and booking. Feature presence is not enough.

## Proof Command

Run the proof gate against an evidence JSON file:

    pnpm -C platform --filter @reload/server first-customer:proof -- --file /path/to/first-customer-proof.json

The command exits non-zero and prints requirement-level gaps until every requirement is proven. It accepts
stdin too:

    cat /path/to/first-customer-proof.json | pnpm -C platform --filter @reload/server first-customer:proof

## Required Evidence Shape

The JSON must match the FirstCustomerProof contract in apps/server/src/first-customer/proof.ts.

Minimum passing evidence proves:

- a real prospect source with zero fabricated/example prospects
- a single `trackingRef` that follows the same buyer through source, send, inbound lead, and booking/trial link
- a real Postmark delivery to the prospect with a #13 approval id
- a production_readback ESP receipt carrying the provider message id
- the prospect reply ingested from the same delivered email address and visible in both lead timeline and inbox
- an inbound_lead route for the same email/trackingRef that auto-qualified, acknowledged, and routed the lead
- a reachable booking or trial HTTP(S) link that carries the same `trackingRef`

The gate intentionally rejects Frankenstein evidence: a valid import, a valid Postmark receipt, a valid reply,
and a valid booking link do not prove first-customer readiness unless they belong to the same buyer.

## Closure Boundary

Do not close #908 from a passing unit test or a synthetic evidence file. Close only after the command is run
against production-derived evidence from a clean deployment and the referenced receipts/readbacks can be
inspected without exposing secrets.
