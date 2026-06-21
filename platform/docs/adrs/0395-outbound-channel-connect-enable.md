# ADR-0395: Connect + enable ONE real outbound channel — the connect + readback-receipt ledger

- **Status:** Accepted (revenue blocker #1 — #395)
- **Date:** 2026-06-21
- **Context issue:** [#395](https://github.com/gagan114662/agent-skills/issues/395) — "Revenue blocker #1:
  connect + enable ONE real outbound channel — the fleet can only touch its own site, never reaches a
  stranger." Every outbound channel is dry-run; a dollar requires artifact → exposure to a real stranger →
  signup → payment, and with every send simulated the marketing never leaves the building.
- **Builds on:** ADR-0258 (connect-once integrations — the owner grants access once, the agents do the
  setup), ADR-0268 (the Postmark ESP provider + always-gated live send + `MessageID`-as-receipt), ADR-0463
  (the `send_outbound_email` tool that parks a PENDING #13 for every outbound email), ADR-0013 (the #13
  approval gate), ADR-0189 (the `external.send` acquisition dispatcher + the `acquisition.*` flags),
  ADR-0337 (the external receipt — `isExternalReceipt`), ADR-0200 (premortem rails: §3 verification must
  touch reality, §4 reversibility, §6 untrusted DATA).

## Context

Most of the machinery already exists: the Postmark provider (#268), the always-gated live send, the
`send_outbound_email` tool (#463) that parks a #13 for every outbound email, and the `acquisition.enabled`
+ `acquisition.email` flags (#189, both default OFF). What was missing for #395 was the connective tissue
that makes "is ONE channel actually connected, enabled, and *proven* to reach a real inbox?" a queryable,
durable fact:

1. No channel-level **connect ledger.** The #192 credential vault stores the secret but never returns it
   and is not channel-typed, so nothing answers "is the email channel connected, by whom, from which
   sending identity?" without touching secrets.
2. No durable **readback receipt.** The external receipt (#337) was a pure value object with no table — a
   proven send left no row, so "a real send reached a real inbox" (#200 §3) could not be counted.

The live Postmark credential and the owner OAuth consent are genuinely owner-gated — they are the owner's
account. The fleet must never forge them.

## Decision

Add the lowest-risk first channel (Postmark email, #268 — owner-reviewed per send, no money, built
compliance/deliverability guards) as a **connect + receipt ledger**, reusing every existing lever.

1. **Vocabulary is a pure leaf** (`outbound-channel/constants.ts`): `OUTBOUND_CHANNELS = ["email_postmark"]`,
   the status union (`pending | connected | revoked`), and the receipt sources. The Drizzle schema and the
   pure unit-tested logic share it without dragging the ORM into the no-DB unit job.
2. **Two additive, workspace-scoped tables** (`drizzle/0505_outbound_channel.sql`, up + down):
   `outbound_channels` (the connect-once ledger) holds **NO secret** — only a non-reversible credential
   *fingerprint*, the verified From address, and status. `outbound_send_receipts` is the append-only #200 §3
   ledger, each row tied to the `approval_request_id` that authorized the send; `verified` is true only for
   a receipt that passed `isExternalReceipt`.
3. **Flags are reused, not duplicated** (#395 §2): the global master switch is `acquisition.enabled`
   (`RELOAD_ACQUISITION_ENABLED`) and the per-channel switch is `acquisition.email`, BOTH default OFF,
   owner-workspace-first via `acquisition.ownerWorkspaceId`. `flags.ts` reads that block; the flag alone
   never sends.
4. **Structural always-gate** (`send-gate.ts`, pure): `decideChannelSend` returns `proceed:true` only when
   the flags are live AND the channel is connected AND an owner #13 approval id is present. There is no
   autonomous path. (Email spends no money; where a future channel does, the #13 money path gates it too.)
5. **The credential stays owner-gated** (`service.ts`): `connectChannel` reads the Postmark server token
   inline from the deployment env at call time, stores ONLY its fingerprint, and **never** persists, logs,
   or returns the token. With no credential set it refuses and names the one manual owner step
   (`fly secrets set POSTMARK_SERVER_TOKEN=...`).
6. **The readback-receipt verification path** (`service.ts` `verifyAndRecordSend`): after a send it runs an
   injected probe that TOUCHES REALITY (a delivery read-back carrying the Postmark `MessageID`, or a
   live-URL probe), runs the result through `isExternalReceipt`, and persists the verdict. The default probe
   returns nothing — no readback wired means no fabricated proof. A real send reached a real inbox ⇔ a
   `production_readback` receipt passes the predicate.
7. **Two MCP tools** (`mcp/server.ts`): `check_channel_connection` reports status + sending-enabled +
   `credentialConfigured` (a boolean, never the value) + the count of verified-inbox receipts;
   `send_through_channel` pre-flights the connect + flag gate, then parks the send behind a #13 approval via
   the existing #463 submitter. All copy is customer-safe — no internal agent chatter.

## Consequences

- **One channel can be connected, enabled, and proven — all queryable.** The revenue-blocker dashboard can
  read "connected? enabled? how many sends reached a real inbox?" from the ledger, the missing truth.
- **Recorded-only this slice.** This PR ships the connect ledger, the flags wiring, the receipt path, and
  the tools. The owner OAuth consent + live Postmark credential are the owner's manual step; auto-recording
  the receipt on the #13 approve path (wiring the live delivery-webhook probe into the executor) is the
  follow-up. Ad **spend** stays money-gated behind the #13 money path, unchanged.
- **No secret is ever forged or stored.** The token rides only the Postmark request header (#268); the
  ledger keeps a fingerprint. Recipient / provider / external-ref are untrusted observed DATA (#200 §6).
- **No new approval path, no new money action.** Sends ride the existing #463 → `external.send` → Postmark
  path; this only adds the channel ledger, the proof ledger, and the two read/send tools.
