import type {
  ReachChannel,
  ReachReceiptKind,
  ReachSendStatus,
  ReachSignalKind,
  ReachVariant,
} from "./types.js";

/**
 * Measurement (#280 step 7). Pure roll-up of what a batch produced: prospects found, messages sent, and
 * the EXTERNAL engagement receipts (opens / replies / booked) — the only source of outcome truth. Broken
 * down by variant, signal kind, and send hour so self-tune (#280 step 8) has something to learn from.
 *
 * Receipts are pre-attributed by the caller to the variant/signal/hour of the originating send (the DB
 * join lives in the repo); this module just tallies — it never re-derives attribution.
 */

/** One sent message, flattened for tallying. */
export interface SendDatum {
  channel: ReachChannel;
  status: ReachSendStatus;
  variant: ReachVariant;
  signalKind: ReachSignalKind | null;
  /** UTC hour (0–23) the send fired, or null. */
  sentHourUtc: number | null;
  /** Sending domain used for email, when known. */
  sendingDomain?: string | null;
}

/** One external engagement receipt, carrying the originating send's attribution. */
export interface ReceiptDatum {
  kind: ReachReceiptKind;
  variant: ReachVariant | null;
  signalKind: ReachSignalKind | null;
  sentHourUtc: number | null;
  /** Sending domain of the originating email send, when known. */
  sendingDomain?: string | null;
}

export interface VariantTally {
  variant: ReachVariant;
  sent: number;
  opens: number;
  replies: number;
  booked: number;
  /** replies / sent, in [0,1]; 0 when nothing was sent. */
  replyRate: number;
}

export interface SignalTally {
  signalKind: ReachSignalKind;
  sent: number;
  replies: number;
  booked: number;
  replyRate: number;
}

export interface HourTally {
  hourUtc: number;
  sent: number;
  replies: number;
  replyRate: number;
}

export interface ReachMetrics {
  prospectsFound: number;
  /** Distinct prospects we attempted to contact (a send row was written, any status). */
  contacted: number;
  sent: number;
  queued: number;
  suppressed: number;
  rateLimited: number;
  opens: number;
  replies: number;
  booked: number;
  bounces: number;
  complaints: number;
  /** Rates over `sent` (the deliverable denominator), each in [0,1]. */
  openRate: number;
  replyRate: number;
  bookedRate: number;
  bounceRate: number;
  complaintRate: number;
  byVariant: VariantTally[];
  bySignalKind: SignalTally[];
  byHour: HourTally[];
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

export interface MeasureInput {
  prospectsFound: number;
  sends: SendDatum[];
  receipts: ReceiptDatum[];
}

/** Tally a batch into {@link ReachMetrics}. Deterministic; ordering of breakdown rows is stable. */
export function computeMetrics(input: MeasureInput): ReachMetrics {
  const { sends, receipts } = input;
  const sent = sends.filter((s) => s.status === "sent").length;
  const queued = sends.filter((s) => s.status === "queued").length;
  const suppressed = sends.filter((s) => s.status === "suppressed").length;
  const rateLimited = sends.filter((s) => s.status === "rate_limited").length;

  const opens = receipts.filter((r) => r.kind === "open").length;
  const replies = receipts.filter((r) => r.kind === "reply").length;
  const booked = receipts.filter((r) => r.kind === "booked").length;
  const bounces = receipts.filter((r) => r.kind === "bounce").length;
  const complaints = receipts.filter((r) => r.kind === "complaint").length;

  // Per-variant: count only delivered ("sent") messages in the denominator.
  const variantMap = new Map<ReachVariant, VariantTally>();
  const ensureVariant = (v: ReachVariant): VariantTally => {
    let t = variantMap.get(v);
    if (!t) {
      t = { variant: v, sent: 0, opens: 0, replies: 0, booked: 0, replyRate: 0 };
      variantMap.set(v, t);
    }
    return t;
  };
  for (const s of sends) if (s.status === "sent") ensureVariant(s.variant).sent += 1;
  for (const r of receipts) {
    if (!r.variant) continue;
    const t = ensureVariant(r.variant);
    if (r.kind === "open") t.opens += 1;
    else if (r.kind === "reply") t.replies += 1;
    else if (r.kind === "booked") t.booked += 1;
  }
  const byVariant = [...variantMap.values()]
    .map((t) => ({ ...t, replyRate: rate(t.replies, t.sent) }))
    .sort((a, b) => b.replyRate - a.replyRate || a.variant.localeCompare(b.variant));

  // Per-signal-kind.
  const signalMap = new Map<ReachSignalKind, SignalTally>();
  const ensureSignal = (k: ReachSignalKind): SignalTally => {
    let t = signalMap.get(k);
    if (!t) {
      t = { signalKind: k, sent: 0, replies: 0, booked: 0, replyRate: 0 };
      signalMap.set(k, t);
    }
    return t;
  };
  for (const s of sends) if (s.status === "sent" && s.signalKind) ensureSignal(s.signalKind).sent += 1;
  for (const r of receipts) {
    if (!r.signalKind) continue;
    const t = ensureSignal(r.signalKind);
    if (r.kind === "reply") t.replies += 1;
    else if (r.kind === "booked") t.booked += 1;
  }
  const bySignalKind = [...signalMap.values()]
    .map((t) => ({ ...t, replyRate: rate(t.replies, t.sent) }))
    .sort((a, b) => b.replyRate - a.replyRate || a.signalKind.localeCompare(b.signalKind));

  // Per-hour.
  const hourMap = new Map<number, HourTally>();
  const ensureHour = (h: number): HourTally => {
    let t = hourMap.get(h);
    if (!t) {
      t = { hourUtc: h, sent: 0, replies: 0, replyRate: 0 };
      hourMap.set(h, t);
    }
    return t;
  };
  for (const s of sends) if (s.status === "sent" && s.sentHourUtc !== null) ensureHour(s.sentHourUtc).sent += 1;
  for (const r of receipts) if (r.kind === "reply" && r.sentHourUtc !== null) ensureHour(r.sentHourUtc).replies += 1;
  const byHour = [...hourMap.values()]
    .map((t) => ({ ...t, replyRate: rate(t.replies, t.sent) }))
    .sort((a, b) => a.hourUtc - b.hourUtc);

  return {
    prospectsFound: input.prospectsFound,
    contacted: sends.length,
    sent,
    queued,
    suppressed,
    rateLimited,
    opens,
    replies,
    booked,
    bounces,
    complaints,
    openRate: rate(opens, sent),
    replyRate: rate(replies, sent),
    bookedRate: rate(booked, sent),
    bounceRate: rate(bounces, sent),
    complaintRate: rate(complaints, sent),
    byVariant,
    bySignalKind,
    byHour,
  };
}
