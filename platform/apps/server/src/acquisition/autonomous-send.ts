/**
 * Autonomous outreach send within hard caps (issue #403, ADR-0403). This is the pure decision that lets the
 * fleet send outreach WITHOUT a human #13 yes per message — bounded by a HARD, pre-committed rate cap and the
 * existing compliance (warmup, CAN-SPAM, suppression) — and escalates to the #13 gate ONLY over-cap or on a
 * compliance flag. It is the #340 hard-cap model applied to SENDS: the human owns the cap and the kill-switch,
 * not each individual message.
 *
 * It COMPLETES the `autoSend` story that `acquisition/caps.ts` + `decideSendGate` started. `decideSendGate`
 * promotes a send to `auto` inside a per-WINDOW cap but `blocks` outright when the window is full and has no
 * never-exceed DAILY backstop; this decision adds (a) the daily hard cap the system can never cross
 * autonomously and (b) the over-cap ESCALATION to the human #13 gate (vs a silent block), exactly like #340's
 * over-budget breach routes to #13. The window cap and the daily cap are both pre-committed config; only a
 * HUMAN can raise them — that is the never-exceed line.
 *
 * Safe by construction:
 *  - Default OFF: when autonomous send is not enabled, EVERY send returns `gate_13` — today's per-send human
 *    gate, byte-for-byte unchanged.
 *  - Compliance always wins: a failed suppression/CAN-SPAM/warmup check or a suppressed recipient is `blocked`,
 *    never autonomous — there is no input that turns a non-compliant send autonomous.
 *  - Over either cap escalates to `gate_13` (the human), never silently drops and never auto-exceeds.
 *
 * Pure + total: a function of (flags + counts) only. No clock, no IO — counts and flags are injected, so it is
 * unit-tested offline with no DB and no network.
 */

export type AutonomousSendAction = "send_autonomous" | "gate_13" | "blocked";

export interface AutonomousSendInput {
  /** Master switch for the autonomous-send layer (default OFF). When false, every send is `gate_13`. */
  autonomousEnabled: boolean;
  /** Sends already made in the current rolling window (the per-window pre-commitment bound). */
  sentInWindow: number;
  /** The pre-committed per-window send cap (the rolling-window bound; only a human may raise it). */
  windowCap: number;
  /** The HARD never-exceed daily cap — the backstop the system can never cross autonomously (#340 model). */
  hardDailyCap: number;
  /** Sends already made today (counted against the hard daily cap). */
  sentToday: number;
  /** Did suppression + CAN-SPAM + warmup all pass? (the in-code compliance gate; a fail can never go auto). */
  complianceOk: boolean;
  /** Is the recipient on the suppression list? A suppressed recipient is a hard block (never autonomous). */
  recipientSuppressed: boolean;
  /** Is the sending domain still inside its warmup ramp? (advisory — the cap math below still governs). */
  withinWarmupRamp: boolean;
}

export interface AutonomousSendDecision {
  action: AutonomousSendAction;
  reason: string;
}

/**
 * Decide whether an outreach send may go out autonomously, must escalate to the human #13 gate, or must be
 * blocked. Rules (evaluated in this order so the safe outcomes win first):
 *
 *  1. NOT `autonomousEnabled` ⇒ `gate_13` — today's behavior: every send needs the human #13 yes.
 *  2. `recipientSuppressed` OR NOT `complianceOk` ⇒ `blocked` — compliance always wins, never autonomous.
 *  3. Enabled + compliant + `sentInWindow < windowCap` + `sentToday < hardDailyCap` ⇒ `send_autonomous`
 *     (no human — inside both pre-committed caps).
 *  4. Otherwise (over the window cap OR over the hard daily cap) ⇒ `gate_13` — escalate to the human, who
 *     owns the never-exceed line (the #340 over-cap-breach model). The system never crosses a cap on its own.
 *
 * Total + pure. There is no input that yields `send_autonomous` while a compliance check fails or a cap is
 * reached; the hard daily cap is the backstop the system cannot autonomously exceed.
 */
export function decideAutonomousSend(input: AutonomousSendInput): AutonomousSendDecision {
  // 1. Default OFF — the autonomous layer is opt-in. Every send falls back to the per-send #13 human gate.
  if (!input.autonomousEnabled) {
    return { action: "gate_13", reason: "autonomous send not enabled — every send needs the #13 human yes" };
  }

  // 2. Compliance always wins: a suppressed recipient or any failed compliance check is a hard block. A
  //    non-compliant send can NEVER become autonomous (and is not escalated to a human — it is dropped).
  if (input.recipientSuppressed) {
    return { action: "blocked", reason: "recipient is suppressed (bounce/complaint/unsubscribe) — dropped" };
  }
  if (!input.complianceOk) {
    return { action: "blocked", reason: "compliance check failed (suppression/CAN-SPAM/warmup) — dropped" };
  }

  // 3. Inside BOTH pre-committed caps ⇒ autonomous, no human. The window cap bounds short bursts; the hard
  //    daily cap is the never-exceed backstop. Both must have headroom.
  const windowHeadroom = input.windowCap > 0 && input.sentInWindow < input.windowCap;
  const dailyHeadroom = input.hardDailyCap > 0 && input.sentToday < input.hardDailyCap;
  if (windowHeadroom && dailyHeadroom) {
    return {
      action: "send_autonomous",
      reason: `within caps (window ${input.sentInWindow}/${input.windowCap}, daily ${input.sentToday}/${input.hardDailyCap})${input.withinWarmupRamp ? " — warming" : ""}`,
    };
  }

  // 4. Over a cap ⇒ escalate to the human #13 gate (never auto-exceed, never silently block). The cap is the
  //    never-exceed line; only a human raising it lets more through (the #340 over-cap-breach model).
  if (!dailyHeadroom) {
    return {
      action: "gate_13",
      reason: `hard daily cap reached (${input.sentToday}/${input.hardDailyCap}) — only a human may send more`,
    };
  }
  return {
    action: "gate_13",
    reason: `window cap reached (${input.sentInWindow}/${input.windowCap}) — escalating to the #13 human gate`,
  };
}
