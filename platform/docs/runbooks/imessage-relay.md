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
- Apple Messages is reachable through AppleScript without sending a message
- the local Messages `chat.db` is readable when inbound sync is enabled
- the API accepts a signed relay heartbeat

It does not claim queued jobs and does not send an iMessage.

### macOS permissions

The relay needs two separate macOS permissions before a real user-visible room loop can pass:

1. **Automation for Messages.** If the doctor prints `FAIL messages-access`, open
   **System Settings > Privacy & Security > Automation** and allow the terminal/Codex process that runs the relay
   to control **Messages**. Keep Messages open and signed in, then rerun the doctor.
2. **Messages database read access.** If the doctor prints `FAIL messages-db` with `authorization denied`,
   open **System Settings > Privacy & Security > Full Disk Access** and grant access to the terminal/Codex process
   that runs the relay. Alternatively set `IMESSAGE_MESSAGES_DB_PATH` to a readable copy of
   `~/Library/Messages/chat.db` for a constrained relay host.

Do not start the worker for production proof until the doctor shows `PASS messages-access`, `PASS messages-db`,
and `PASS api-heartbeat`.

After the doctor passes, start the worker:

```sh
pnpm -C platform --filter @reload/server imessage:relay
```

For one polling/send cycle during manual QA:

```sh
pnpm -C platform --filter @reload/server imessage:relay -- --once
```

## Keep the Mac Relay Running

For production proof, run the relay as a user LaunchAgent after the doctor passes. The LaunchAgent sources
`~/.ipop/imessage-relay.env` at runtime, so the shared secret stays in the local env file instead of being embedded
in the plist.

Preview the plist without writing it:

```sh
pnpm -C platform --filter @reload/server imessage:relay:launch-agent -- --print
```

Install the plist and create the log directory:

```sh
pnpm -C platform --filter @reload/server imessage:relay:launch-agent -- --install
```

Load or restart it with launchd:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.ipop.imessage-relay.plist
launchctl kickstart -k gui/$(id -u)/ai.ipop.imessage-relay
```

Unload it:

```sh
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.ipop.imessage-relay.plist
```

If the repo or env file lives somewhere else, pass `--repo-dir <path>` or `--env-file <path>` when generating the
LaunchAgent.

## Closure Proof

Do not close #1341 until production evidence shows:

- `/me/imessage/status` reports an active `relayHeartbeat` from the Mac host
- verification send queues, is claimed by the Mac relay, and completes as `sent`
- room send queues, is claimed by the Mac relay, and completes as `sent`
- inbound `POST /imessage/relay/inbound` records a real user reply into the correct ipop room thread
- live `/readyz` is green and `/version` matches the deployed relay code
