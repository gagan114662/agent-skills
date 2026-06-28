# External Room Bridges Runbook

Issue #1267 tracks live Telegram and WhatsApp windows into the canonical ipop room. Code presence is not enough:
do not mark either channel production-ready until provider credentials are configured and a live round trip is
proven.

## Doctor

Run the safe provider setup doctor from the repo root:

    pnpm -C platform --filter @reload/server room:doctor

The doctor reports missing Telegram and WhatsApp env vars by name only, verifies Telegram bot identity with
getMe, verifies the WhatsApp sender with the Graph phone-number lookup, checks that the local WhatsApp
signature verifier rejects invalid signatures, and skips sends by default.

To send an explicit smoke message to the configured dogfood chat or recipient:

    pnpm -C platform --filter @reload/server room:doctor -- --send-smoke --text "ipop room bridge smoke"

Only run --send-smoke after the configured chat or recipient is known to be the owner dogfood channel.

To make the smoke auditable against the canonical web room, pass the room correlation ids from an existing
workspace/channel/message:

    pnpm -C platform --filter @reload/server room:doctor -- --send-smoke --text "ipop room bridge smoke" --workspace-id <workspace-id> --channel-id <channel-id> --message-id <message-id>

With those ids present, the doctor records each provider MessageID in external_room_message_receipts. Without
them, the doctor can prove provider reachability but cannot prove the provider message maps back to the room.

## Telegram Production Checklist

Required env: TELEGRAM_BOT_TOKEN, TELEGRAM_ROOM_CHAT_ID, TELEGRAM_WEBHOOK_SECRET.

Provider setup: configure Telegram to send webhooks to https://api.ipop.ai/telegram/webhook, with
X-Telegram-Bot-Api-Secret-Token set to the same TELEGRAM_WEBHOOK_SECRET.

Proof before closure: room:doctor passes Telegram config and identity; room:doctor -- --send-smoke sends a
tagged message to the connected Telegram chat and records the provider MessageID with the room correlation
ids; a reply in Telegram lands back in the canonical ipop web room; an explicit approval command with a
concrete approval id resolves through the canonical approval path.

## WhatsApp Production Checklist

Required env: WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ROOM_RECIPIENT,
WHATSAPP_WEBHOOK_VERIFY_TOKEN, WHATSAPP_APP_SECRET.

Provider setup: configure the Meta webhook callback URL to https://api.ipop.ai/whatsapp/webhook, use
WHATSAPP_WEBHOOK_VERIFY_TOKEN for the GET challenge, and ensure Meta signs POST webhooks with
X-Hub-Signature-256 so ipop can verify them with WHATSAPP_APP_SECRET.

Proof before closure: room:doctor passes WhatsApp config, sender lookup, and signature checks; room:doctor
-- --send-smoke sends a tagged message to the connected WhatsApp recipient and records the provider MessageID
with the room correlation ids; a context reply in WhatsApp lands back in the canonical ipop web room; an
explicit approval command with a concrete approval id resolves through the canonical approval path.
