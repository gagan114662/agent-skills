/**
 * Finance CSV export (#194, ADR-0194). **Pure** string building — the period statement the human
 * accountant gets at tax time. No IO; the route streams the returned string as `text/csv`. RFC-4180
 * quoting (double a `"`, wrap any field containing `"`, `,`, or a newline) so a memo with a comma
 * never corrupts the columns.
 */

import type { ClosePack, LedgerEntry } from "./ledger.js";

/** Quote one CSV field per RFC-4180 (only when it must be quoted). */
function csvField(value: string | number | boolean | null): string {
  const s = value === null ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Join one CSV row from already-stringified-or-primitive cells. */
function csvRow(cells: Array<string | number | boolean | null>): string {
  return cells.map(csvField).join(",");
}

/** A money amount in cents → a plain decimal string (`1234` → `12.34`) for the statement. */
function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

const LEDGER_HEADER = [
  "id",
  "occurred_at",
  "venture_idea_id",
  "direction",
  "category",
  "amount",
  "currency",
  "verified",
  "source",
  "source_ref",
  "memo",
];

/** A line-by-line statement of ledger entries, newest economic event first. */
export function ledgerEntriesToCsv(entries: LedgerEntry[]): string {
  const rows = [...entries]
    .sort((a, b) => b.occurredAtMs - a.occurredAtMs)
    .map((e) =>
      csvRow([
        e.id,
        new Date(e.occurredAtMs).toISOString(),
        e.ventureIdeaId,
        e.direction,
        e.category,
        money(e.amountCents),
        e.currency,
        e.verified,
        e.source,
        e.sourceRef,
        e.memo,
      ]),
    );
  return [csvRow(LEDGER_HEADER), ...rows].join("\n") + "\n";
}

const CLOSE_HEADER = [
  "period_key",
  "venture_idea_id",
  "currency",
  "revenue",
  "cost",
  "verified_cost",
  "net",
  "verified_share_pct",
  "cac",
  "ltv",
  "margin_pct",
  "entries",
];

/** A period-by-period statement of closed books — the accountant's P&L roll-up. */
export function closePacksToCsv(packs: ClosePack[]): string {
  const rows = [...packs]
    .sort((a, b) => (a.periodKey < b.periodKey ? 1 : a.periodKey > b.periodKey ? -1 : 0))
    .map((p) =>
      csvRow([
        p.periodKey,
        p.ventureIdeaId,
        p.currency,
        money(p.revenueCents),
        money(p.costCents),
        money(p.verifiedCostCents),
        money(p.netCents),
        (p.verifiedShareBps / 100).toFixed(2),
        p.unitEconomics.cacCents === null ? null : money(p.unitEconomics.cacCents),
        p.unitEconomics.ltvCents === null ? null : money(p.unitEconomics.ltvCents),
        p.unitEconomics.marginBps === null ? null : (p.unitEconomics.marginBps / 100).toFixed(2),
        p.entryCount,
      ]),
    );
  return [csvRow(CLOSE_HEADER), ...rows].join("\n") + "\n";
}
