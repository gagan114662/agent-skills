# External Room Proof Gate

Issue: #1267

The external room doctor proves provider configuration and smoke-send reachability. This proof gate proves the
product-visible room loop from one correlated artifact:

- the canonical web room is visible and marked as the source of truth
- a connected external provider delivered the same room event and returned a native message id
- the user's reply from that provider threaded back into the same web room
- an approval decision resolved through the canonical approval path and audit receipt
- preview and receipt links are permission-safe HTTP(S) URLs

## Collect Proof

Use this after running the real channel flow with Telegram, WhatsApp, or iMessage. The proof JSON should be built
from production receipts, room message rows, inbound webhook rows, and approval audit rows. Do not hand-edit missing
provider ids or mark a provider connected unless the provider returned the native receipt.

```sh
pnpm -C platform --filter @reload/server external-room:proof -- --file /path/to/external-room-proof.json
```

You can also pipe JSON on stdin:

```sh
cat /path/to/external-room-proof.json | pnpm -C platform --filter @reload/server external-room:proof
```

Passing output looks like:

```text
PASS external-room-proof: web room -> external delivery -> inbound reply -> approval audit proven
```

Failing output lists each missing requirement:

```text
FAIL external-room-proof: 2 gap(s)
FAIL external_delivery: A connected provider must send the room event and return a native provider message id plus receipt.
FAIL inbound_reply: The user's provider reply must be threaded back into the same canonical web room.
```

## Proof Boundary

This gate does not create provider credentials, send a message by itself, or prove a fresh end-to-end provider run.
It fails closed over a proof artifact from the actual run. Keep #1267 open until a production artifact from a real
Telegram, WhatsApp, or iMessage room includes all fields and this command passes against it.
