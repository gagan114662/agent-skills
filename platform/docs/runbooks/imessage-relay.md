# iMessage Relay Runbook

Issue: #1341

Production API cannot run Apple Messages directly because Fly/Linux cannot use `osascript` against a logged-in Messages session. The iMessage room path requires a signed Mac relay host.

## API Setup

Set the same shared secret on the API and the Mac host:

```sh
IMESSAGE_RELAY_WEBHOOK_SECRET=...
```

The API release preflight fails until this is present. That is intentional: without it, outbound claim/complete, heartbeat, and inbound reply endpoints must fail closed.

## Mac Host Setup

Run on a logged-in macOS account that can send iMessages from Apple Messages:

```sh
export IMESSAGE_RELAY_API_BASE=https://api.ipop.ai
export IMESSAGE_RELAY_WEBHOOK_SECRET=...
export IMESSAGE_RELAY_ID=gagan-mac
export IMESSAGE_RELAY_VERSION=$(git rev-parse --short HEAD)

pnpm -C platform --filter @reload/server imessage:relay:doctor
```

The doctor is safe to run during setup. It checks:

- this is a macOS-capable worker environment
- `osascript` can execute a harmless script
- the API accepts a signed relay heartbeat

It does not claim queued jobs and does not send an iMessage.

After the doctor passes, start the worker:

```sh
pnpm -C platform --filter @reload/server imessage:relay
```

For one polling/send cycle during manual QA:

```sh
pnpm -C platform --filter @reload/server imessage:relay -- --once
```

## Closure Proof

Do not close #1341 until production evidence shows:

- `/me/imessage/status` reports an active `relayHeartbeat` from the Mac host
- verification send queues, is claimed by the Mac relay, and completes as `sent`
- room send queues, is claimed by the Mac relay, and completes as `sent`
- inbound `POST /imessage/relay/inbound` records a real user reply into the correct ipop room thread
- live `/readyz` is green and `/version` matches the deployed relay code
