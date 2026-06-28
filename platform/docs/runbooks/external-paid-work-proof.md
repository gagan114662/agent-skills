# External paid-work proof runbook

Use this to prove #387: ipop earned money by doing externally sourced paid work for someone else, not by marketing ipop to itself.

## Validate proof JSON

```sh
pnpm -C platform --filter @reload/server external-paid-work:proof -- --file /path/to/external-paid-work-proof.json
```

or:

```sh
cat /path/to/external-paid-work-proof.json | pnpm -C platform --filter @reload/server external-paid-work:proof
```

## Required evidence

- `opportunity`: externally sourced paid work with a real source URL, external customer ref, positive value, and `selfMarketing: false`.
- `deliverable`: durable deliverable ref with verification passed and production-grounded verification receipt.
- `delivery`: #13 approval id plus production readback receipt for sending the deliverable to the external customer.
- `payment`: real provider event from Stripe, PayPal, bank, or marketplace with positive amount and production readback receipt tied to the same customer ref.

## Closure boundary

Do not close #387 from demos, self-marketing, generated sample bounties, or manual payment claims. The proof must pass the CLI on a clean checkout and the referenced receipts must be real production/provider readbacks.
