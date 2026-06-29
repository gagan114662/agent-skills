# Issue #1426: Messaging Round-Trip Readiness

## Problem

The messaging channels need an operational readiness signal that proves real round-trip behavior. A provider token,
webhook secret, or connected destination does not prove the customer can watch the agents in Telegram, WhatsApp, or
iMessage and reply back into the same canonical room.

## Contract

Authenticated owners can call:

```bash
curl -fsS -H "Cookie: rid=$RID" https://api.ipop.ai/me/messaging-readiness
```

The response is secret-free and reports each provider as one of:

- `disabled`
- `config_missing`
- `configured_unproven`
- `outbound_sent`
- `inbound_received`
- `healthy`

`healthy` requires fresh outbound proof and fresh inbound proof. Proof expires after seven days so production QA catches
stale one-off smoke tests.

## Provider Proof

- Telegram and WhatsApp use `external_room_message_receipts` with `direction = outbound | inbound`.
- Telegram and WhatsApp webhook replies record inbound proof only after ipop has accepted the reply into the canonical
  room.
- iMessage uses the signed Mac relay records: verified recipient, latest sent relay job, latest inbound relay receipt,
  and an active relay heartbeat.

## Non-Goals

- This endpoint does not expose provider tokens, webhook secrets, or sealed credential values.
- This endpoint does not make the web homepage the source of truth; it only reports messaging-channel readiness.
