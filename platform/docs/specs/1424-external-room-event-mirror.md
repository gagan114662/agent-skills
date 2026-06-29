# Spec: External Room Event Mirror (#1424)

## Objective

Make Telegram and WhatsApp connected rooms receive canonical ipop room activity automatically. A user
who connects a messaging room should see normal web room posts and agent/team progress without calling
provider-specific send endpoints.

Assumptions:

- The signed-in web room remains the canonical transcript.
- Telegram and WhatsApp room connections are workspace-level destinations stored in the existing
  external-credentials vault.
- Provider delivery is best-effort and must not fail the canonical message write.
- iMessage remains blocked until the Mac relay host is production-ready; this slice does not fake it.

## Tech Stack

- TypeScript server under `platform/apps/server/src`
- Fastify route fan-out for human posts
- Runtime `channelPoster` for agent/team posts
- Drizzle/Postgres repositories for credentials and external room receipts
- Vitest integration/unit coverage

## Commands

- Typecheck: `pnpm --filter @reload/server typecheck`
- Focused tests: `pnpm --filter @reload/server exec vitest run --config vitest.config.ts test/unit/external-room-mirror.test.ts test/integration/telegram.test.ts test/integration/whatsapp.test.ts`
- Whitespace gate: `git diff --check`

## Project Structure

- `platform/apps/server/src/messaging/external-room-mirror.ts` - formatter and fan-out service
- `platform/apps/server/src/messaging/delivery.ts` - human room post/thread reply hook
- `platform/apps/server/src/runtime/default.ts` - agent/team post hook
- `platform/apps/server/src/app.ts` - wire provider services into the mirror
- `platform/apps/server/test/unit/external-room-mirror.test.ts` - pure formatting/idempotency coverage
- `platform/apps/server/test/integration/telegram.test.ts` and `whatsapp.test.ts` - provider route regressions

## Code Style

```ts
await mirrorExternalRoomPost(log, {
  workspaceId: identity.workspaceId,
  channelId: channel.id,
  message,
  author: identity.displayName,
  source: "room_message",
});
```

Use narrow, explicit inputs. Provider failures are logged and stored as retryable health signals where
possible, never thrown back into room delivery.

## Testing Strategy

- Unit-test event classification and receipt-based idempotency without network calls.
- Integration-test that connected Telegram/WhatsApp rooms receive normal web posts automatically.
- Regression-test that explicit provider room sends and inbound provider messages are not echoed twice.
- Existing #1423 launch tests continue to prove first inbound messages can start the team room.

## Boundaries

- Always: Preserve canonical room writes even when provider delivery fails.
- Always: Record provider receipts for successful mirror sends so external replies can thread back.
- Always: Skip auto-mirroring messages already marked `alsoSentToChannel`.
- Ask first: Database schema changes beyond repository selectors or additive health events.
- Never: Expose decrypted provider secrets, send to unverified destinations, or claim iMessage production
  support before the relay exists.

## Success Criteria

- A normal web room message fans out to connected Telegram and WhatsApp rooms automatically.
- An agent/team `channelPoster` message fans out to connected Telegram and WhatsApp rooms automatically.
- Thread replies and blocked/team event bodies are formatted as chat-native room updates.
- Duplicate mirror attempts for the same message/provider/destination do not send twice.
- Provider failure does not fail the canonical room write.
- Existing provider-specific endpoints and inbound webhook threading remain working without echo loops.

