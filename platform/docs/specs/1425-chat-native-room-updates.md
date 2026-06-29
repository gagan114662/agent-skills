# Spec: Chat-Native External Room Updates (#1425)

## Objective

Make Telegram and WhatsApp room updates read like a premium marketing team in chat instead of raw
technical receipts. Correlation still has to work, but the default message should lead with the useful
agent update.

Assumptions:

- Plain-text fallback receipts are still required because not every provider reply carries native
  reply metadata reliably.
- Provider-native reply ids remain the primary correlation path; visible refs are fallback and audit aids.
- This slice changes message formatting only. Provider buttons, deep message-specific web previews, and
  long-form artifact hosting can follow after #1426 round-trip proof.

## Commands

- Typecheck: `pnpm --filter @reload/server typecheck`
- Focused tests: `pnpm --filter @reload/server exec vitest run --config vitest.config.ts test/unit/telegram-service.test.ts test/unit/whatsapp-service.test.ts test/unit/external-room-mirror.test.ts`
- Integration tests: `pnpm --filter @reload/server exec vitest run --config vitest.config.ts test/integration/telegram.test.ts test/integration/whatsapp.test.ts`
- Whitespace gate: `git diff --check`

## Success Criteria

- Telegram/WhatsApp room messages start with `Author: useful update`.
- No workspace id line appears in default chat text.
- The visible fallback receipt is compressed to a short `ref:` footer.
- Parsers accept both legacy `receipt:` tokens and the new `ref:` tokens.
- Long updates are clipped with a clear pointer to the ipop room instead of becoming chat walls.
- Existing inbound reply threading and approval-command handling keep working.

