# iMessage room proof runbook

Use this to prove #1283: a real user-visible Apple Messages room loop, not just a relay preview or test send.

## Validate proof JSON

```sh
pnpm -C platform --filter @reload/server imessage-room:proof -- --file /path/to/imessage-room-proof.json
```

or:

```sh
cat /path/to/imessage-room-proof.json | pnpm -C platform --filter @reload/server imessage-room:proof
```

## Required evidence

- `recipient`: the signed-in member's iMessage destination is verified by a successful relay send.
- `relay`: a signed Mac relay heartbeat was accepted recently by the production API.
- `roomStart`: the user's start text was persisted in the canonical ipop room with receipt `imessage:<channelId>:<messageId>`.
- `outboundRoomDelivery`: the Mac relay sent the room-start receipt to the verified iMessage recipient.
- `inboundReply`: the user's Apple Messages reply was ingested and visible in the same canonical room.
- `agentResponse`: an agent response was visible in that same room after the inbound reply.
- `outboundReplyDelivery`: the response or acknowledgement was delivered back to the same iMessage recipient by the Mac relay.

## Closure boundary

Do not close #1283 from relay configuration, a heartbeat alone, a verification test, or a dashboard badge. The proof must pass the CLI using production readbacks from the signed Mac relay and the canonical room thread.
