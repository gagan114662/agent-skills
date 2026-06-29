# Spec: User-specific messaging room destinations

## Objective

Make the WhatsApp and Telegram room connectors store a destination chosen by the signed-in user instead of sealing a deployment-wide recipient. Deployment configuration owns sender credentials, webhooks, and provider secrets; the workspace connection owns the user's destination.

## Commands

- Targeted integration tests: `pnpm --filter @reload/server exec vitest run --config vitest.integration.config.ts test/integration/telegram.test.ts test/integration/whatsapp.test.ts`
- Targeted unit tests: `pnpm --filter @reload/server exec vitest run --config vitest.config.ts test/unit/telegram-service.test.ts test/unit/whatsapp-service.test.ts test/unit/connections-view.test.ts test/unit/connections-registry.test.ts`
- Typecheck: `pnpm --filter @reload/server typecheck`

## Project Structure

- Server routes: `platform/apps/server/src/routes/connections.ts`, `routes/telegram.ts`, `routes/whatsapp.ts`
- Provider services: `platform/apps/server/src/telegram/service.ts`, `src/whatsapp/service.ts`
- Tests: `platform/apps/server/test/integration/*` and `platform/apps/server/test/unit/*`

## Code Style

Keep validation at the route boundary and seal only normalized values:

```ts
const chatId = normalizeTelegramChatId(body.chatId);
if (!chatId) return reply.code(400).send({ error: "Telegram chat id is required" });
```

## Testing Strategy

Use existing Fastify integration tests with fake provider transports. Tests must prove that:

- Enabling Telegram/WhatsApp without a destination fails.
- Enabling with a valid destination stores that destination for the workspace.
- Sends and inbound reply checks use the stored destination, not deployment env.

## Boundaries

- Always: keep provider credentials secret, keep provider proof separate from consent, preserve cross-workspace isolation.
- Ask first: adding a new provider dependency, changing database schema, or changing channel-native onboarding scope beyond destination storage.
- Never: mark a messaging connector healthy from env presence alone, expose token material, or rely on a global customer destination.

## Success Criteria

- WhatsApp and Telegram descriptors no longer require deployment-wide customer destination env vars.
- The `/me/connections/:id/enable` route accepts validated destinations for WhatsApp and Telegram.
- Existing room send/webhook flows continue to work with the sealed per-workspace destination.
