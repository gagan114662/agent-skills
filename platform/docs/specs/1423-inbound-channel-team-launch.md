# 1423 Inbound Channel Team Launch

## Goal

Let a first inbound Telegram or WhatsApp message launch the real ipop marketing room instead of requiring
the user to reply to an existing receipt.

## Contract

- The inbound provider conversation must already be connected to exactly one workspace through the
  per-workspace room destination secret.
- The first provider message is persisted as the root message in the canonical `general` room.
- Missing Codex subscription auth blocks the launch, posts a visible room reason, and sends a channel-native
  connect link back to the same provider conversation.
- Connected Codex auth starts a team run through the existing `TeamCoordinator` and channel capability gates.
- Provider message ids are correlated to the root room message so duplicate webhooks are idempotent and
  later provider replies thread into the same canonical room.

## Out of Scope

- Real provider account provisioning and round-trip smoke proof remain tracked by #1426.
- Rewriting the web setup UI remains tracked by #1427.
