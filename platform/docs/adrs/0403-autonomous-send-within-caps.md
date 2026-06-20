# ADR-0403: Autonomous outreach send within a hard rate cap (the #340 model for sends)

- **Status:** Accepted (shipped in working tree for the autonomous-send loop)
- **Date:** 2026-06-19
- **Context:** The owner objected to the per-send human gate — approving every individual outreach message
  does not scale and is not how a real growth team operates. We want the fleet to send outreach WITHOUT a
  human #13 yes per message, bounded by a HARD, pre-committed rate cap plus the existing compliance (warmup,
  CAN-SPAM, suppression), escalating to the #13 gate ONLY over-cap or on a compliance flag.
- **Builds on:** [ADR-0340](0340-enterprise-metering-caps-passport.md) (the hard never-exceed budget-cap
  model — over-cap breaches escalate to #13 rather than auto-exceed; this is that model applied to SENDS),
  [ADR-0268](0268-email-deliverability.md) (the `email.live_send` #13 always-gate this layers on top of, never
  removes), [ADR-0189](0189-acquisition-execution.md) (the `autoSend` / `*WindowCap` pre-commitment concept
  this COMPLETES), [ADR-0243](0243-money-only-approval.md) (the money-only #13 gate — note this issue adds NO
  money path), [ADR-0035](0035-config-layering.md) (layered default-OFF owner-first flags),
  [ADR-0200](0200-premortem-panel.md) (the standing premortem this answers to: §4 irreversible-must-be-bounded,
  §6 untrusted content never drives an autonomous write).
- **Scope:** a pure decision (`decideAutonomousSend`) + a default-OFF owner-first `autonomousSend` config block
  with the hard caps as config; the composed seam (`decideComposedSend`) that consults the autonomous layer
  FIRST and falls back to the existing #13 gate. **Out of scope:** adding a real sender. No new ESP is wired —
  a real email still needs a connected ESP + `liveSendEnabled` (#268) to leave the building; until then every
  autonomous "send" is dry-run/recorded-only. No migration, no money action.

## Context

The per-send #13 gate makes outreach unusable at any real volume. But sending real email is the most
irreversible acquisition action (#200 §4): a bad blast is in a stranger's inbox forever and torches sender
reputation. The resolution is the same one #340 used for money: don't approve every action, approve the CAP.
The human pre-commits a HARD rate cap (a rolling-window cap for bursts + a never-exceed daily backstop); inside
that cap the fleet sends autonomously; over the cap it escalates back to the human. The human owns the cap and
the kill-switch, not each message — and only a human (in config) can raise a cap.

`acquisition/caps.ts` + `decideSendGate` (#189) already started this with an `autoSend` switch and a per-window
cap, but (a) it had no never-exceed DAILY backstop and (b) over the window cap it `blocked` outright instead of
escalating to the human. This issue COMPLETES that story with the #340 escalation model.

## Decision

1. **Pure decision — `acquisition/autonomous-send.ts`.** `decideAutonomousSend(input) → {action, reason}` where
   `action ∈ {"send_autonomous","gate_13","blocked"}`. Rules, in safe-outcome-first order:
   - NOT `autonomousEnabled` ⇒ `gate_13` (today's behavior — every send needs the human #13 yes).
   - `recipientSuppressed` OR NOT `complianceOk` ⇒ `blocked` (compliance always wins; never autonomous, never
     escalated — it is dropped).
   - enabled + compliant + `sentInWindow < windowCap` + `sentToday < hardDailyCap` ⇒ `send_autonomous` (no human).
   - over the window cap OR the hard daily cap ⇒ `gate_13` (escalate to the human, like a #340 cap breach).
   The `hardDailyCap` is the never-exceed backstop the system cannot cross autonomously; only a human raising it
   (in config) lets more through. Pure + total: a function of injected flags + counts, no clock, no IO.

2. **Config — `autonomousSend` block (default OFF, owner-workspace-first), `resolveAutonomousSendCaps`.**
   Mirrors `enterprise`/`emailDeliverability`: `enabled` (default false), `ownerWorkspaceOnly` (default true),
   `ownerWorkspaceId`, `windowCap` and `hardDailyCap` (both default 0 = fail-closed: even flipping `enabled` on
   without setting caps sends NOTHING autonomously). Env override `RELOAD_AUTONOMOUS_SEND_*`.

3. **Composed seam — `decideComposedSend` (in `email/live-send.ts`).** Consults `decideAutonomousSend` FIRST:
   `send_autonomous` ⇒ proceed to the (dry-run unless a real ESP is wired) sender WITHOUT raising #13;
   `blocked` ⇒ drop + record; `gate_13` ⇒ fall back to the existing `decidePostmarkLiveSend` #13 always-gate.
   The #13 path is NEVER removed — autonomous is strictly an opt-in layer ON TOP of it. With the block OFF every
   send is `gate_13`, byte-for-byte today's behavior.

## Consequences

- **Removes the per-send human gate** within a hard, pre-committed cap — the owner's objection is answered while
  keeping the never-exceed safety the premortem demands.
- **Default-OFF, owner-first, fail-closed:** an unset deployment is byte-for-byte unchanged; enabling without an
  owner id or without caps sends nothing autonomously.
- **Compliance always wins:** a suppression/CAN-SPAM/warmup fail is `blocked`, never autonomous — there is no
  input that turns a non-compliant send autonomous.
- **No new sender:** a real email still needs a connected ESP + `liveSendEnabled` to actually leave the building;
  this issue only decides WHETHER a human is required, not whether a real send happens. No money path, no
  migration.
- **The human owns the cap + the kill-switch, not each message.** Raising a cap is a human act (a config change).
