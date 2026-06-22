/**
 * The money classifier at the heart of issue #727 ("Autonomy by default: money is the only hard gate"). It
 * identifies the ONE class of action that is a hard, code-enforced approval gate: **money / spend** — charges,
 * refunds, payouts, connecting live payment keys, and real (paid) ad spend. Everything else (drafts, publishing,
 * non-paid outreach, deploys, even destructive-but-money-free internal ops) runs autonomously by default.
 *
 * Design (the deliberate INVERSION of the #674 content-guard / #670 action-gate fail-closed safety classifiers):
 *  - **Money is the only thing this gate looks for.** A non-money action is never reported as money, so it never
 *    pauses for approval on account of this gate. The product promise — "everything except money ships on its
 *    own" — is implemented here as: only a money action returns `isMoney: true`.
 *  - **Non-toggleable.** There is no input — no flag, no env — that turns a money action into a non-money one.
 *    Opt-out toggles (in `caps.ts`) can only ever ADD gating to other capabilities; they can never relax money.
 *  - **Structural fields only, no free text.** The verdict reads a verb token + boolean hints + structural
 *    surface tokens, never untrusted prose, so a poisoned payload can never flip it (the #200 §6 trust boundary).
 *
 * Pure + total: no IO, no clock, no randomness.
 */

/** A description of a proposed action, for the money gate to rule on. Structural fields only. */
export interface MoneyActionDescriptor {
  /**
   * The operation, e.g. `stripe.charge`, `billing.refund`, `payouts.create`, `ads.launch`, `blog.publish`. The
   * classifier tokenizes on non-letters and matches tokens against its money-verb set, so namespaced/compound
   * forms (`billing.refund`, `payout_create`) resolve to their real verb.
   */
  action: string;
  /** Where the effect lands (a provider, account, ledger). Used for the live-payment-key/ad-spend heuristics. */
  surface?: string | null;
  /** Explicit: this action moves money. `true` forces the money gate on its own (the unambiguous escape hatch). */
  money?: boolean;
  /** Explicit: this action commits REAL (paid) ad spend. `true` forces the money gate. */
  paidAdSpend?: boolean;
  /** Explicit: this action connects/rotates LIVE payment credentials. `true` forces the money gate. */
  connectsLivePaymentKey?: boolean;
  /** The structural payload that scopes the action (e.g. `{ amountCents: 4200 }`). Read only for `live`-ness hints. */
  payload?: Record<string, unknown> | null;
}

/**
 * Unambiguous money-movement verbs — an action whose effect is "money out the door" (it does not come back: #200
 * §4). Kept deliberately tight: an ambiguous verb (e.g. `transfer`, `capture`, `settle`) is NOT here, because
 * over-gating a money-free action would defeat the autonomy promise — callers of a genuinely-money ambiguous verb
 * pass `money: true` instead.
 */
const MONEY_VERBS: ReadonlySet<string> = new Set([
  "charge",
  "pay",
  "payout",
  "payouts",
  "refund",
  "chargeback",
  "withdraw",
  "disburse",
  "remit",
  "wire",
  "bill",
  "purchase",
  "checkout",
  "topup",
  "fund",
]);

/** Tokens that, when present alongside a spend token, signal real ad spend (`ads.launch` with a budget). */
const AD_TOKENS: ReadonlySet<string> = new Set(["ad", "ads", "adwords", "ppc", "sem"]);
const SPEND_TOKENS: ReadonlySet<string> = new Set(["spend", "budget", "bid", "fund", "launch", "boost", "promote"]);

/** Tokens that name a payment surface, for the live-payment-key heuristic. */
const PAYMENT_TOKENS: ReadonlySet<string> = new Set([
  "payment",
  "payments",
  "stripe",
  "paypal",
  "card",
  "bank",
  "ach",
  "payout",
  "billing",
  "merchant",
  "gateway",
]);
const CONNECT_TOKENS: ReadonlySet<string> = new Set(["connect", "link", "add", "attach", "set", "rotate", "store"]);

/** Tokenize an action string into lowercase letter-runs: `billing.refund_card` → `["billing","refund","card"]`. */
function tokenize(value: string | null | undefined): string[] {
  return (value ?? "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length > 0);
}

/** Does the payload carry an explicit live/production marker (e.g. `{ live: true }`, `{ mode: "live" }`)? */
function payloadLooksLive(payload: Record<string, unknown> | null | undefined): boolean {
  if (!payload || typeof payload !== "object") return false;
  if (payload.live === true) return true;
  const mode = payload.mode;
  return typeof mode === "string" && mode.trim().toLowerCase() === "live";
}

/** The money classifier's verdict. Pure data. */
export interface MoneyClassification {
  /** THE answer: is this a money/spend action and therefore the hard approval gate? */
  isMoney: boolean;
  /** The signals that fired (for the audit trail / queue label), e.g. `["verb:charge"]`, `["flag:paidAdSpend"]`. */
  signals: string[];
  reason: string;
}

/**
 * Classify whether a proposed action is a money/spend action. Pure + total. Returns `isMoney: false` for every
 * non-money action (the autonomy default), and `isMoney: true` only when a money signal fires:
 *  - an explicit `money` / `paidAdSpend` / `connectsLivePaymentKey` flag, or
 *  - a money-movement verb token (`charge`, `refund`, `payout`, …), or
 *  - real ad spend (an ad token + a spend token in the action/surface), or
 *  - connecting a live payment key (a connect token + a payment token + a live marker).
 */
export function classifyMoney(action: MoneyActionDescriptor): MoneyClassification {
  const safe = action && typeof action === "object" ? action : { action: "" };
  const tokens = [...tokenize(safe.action), ...tokenize(safe.surface)];
  const tokenSet = new Set(tokens);
  const signals: string[] = [];

  if (safe.money === true) signals.push("flag:money");
  if (safe.paidAdSpend === true) signals.push("flag:paidAdSpend");
  if (safe.connectsLivePaymentKey === true) signals.push("flag:connectsLivePaymentKey");

  for (const t of tokenSet) {
    if (MONEY_VERBS.has(t)) signals.push(`verb:${t}`);
  }

  const hasAd = tokens.some((t) => AD_TOKENS.has(t));
  const hasSpend = tokens.some((t) => SPEND_TOKENS.has(t));
  if (hasAd && hasSpend) signals.push("heuristic:ad_spend");

  const hasConnect = tokens.some((t) => CONNECT_TOKENS.has(t));
  const hasPayment = tokens.some((t) => PAYMENT_TOKENS.has(t));
  if (hasConnect && hasPayment && payloadLooksLive(safe.payload)) signals.push("heuristic:live_payment_key");

  const isMoney = signals.length > 0;
  return {
    isMoney,
    signals,
    reason: isMoney
      ? `money/spend action (${signals.join(", ")}) — recorded human approval required before it executes`
      : "not a money action — autonomous by default",
  };
}

/** Convenience predicate: is this a money/spend action (the one hard gate)? Pure + total. */
export function isMoneyAction(action: MoneyActionDescriptor): boolean {
  return classifyMoney(action).isMoney;
}
