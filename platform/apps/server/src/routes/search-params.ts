/**
 * Pure parsing/validation for the search endpoints (#7). Kept separate from the route
 * handlers so it is unit-testable without Fastify. `q` is required; `limit`/`offset` are
 * clamped (forgiving, not 400) so paging stays robust; dates are coerced from ISO strings.
 */

export interface ParsedSearch {
  q: string;
  limit: number;
  offset: number;
  channelId?: string;
  authorMemberId?: string;
  after?: Date;
  before?: Date;
  threadId?: string;
}

export type ParseResult = { ok: true; value: ParsedSearch } | { ok: false; error: string };

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Clamp a query value to an integer in [min,max], falling back to `fallback`. */
function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Coerce an ISO date string to a Date, or undefined if absent/invalid. */
function toDate(raw: unknown): Date | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Pass through a string filter value, or undefined if absent/blank. */
function toFilter(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() !== "" ? raw : undefined;
}

export function parseSearchParams(query: Record<string, unknown>): ParseResult {
  const q = typeof query.q === "string" ? query.q.trim() : "";
  if (q === "") return { ok: false, error: "q required" };

  return {
    ok: true,
    value: {
      q,
      limit: clampInt(query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT),
      offset: clampInt(query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
      channelId: toFilter(query.channelId),
      authorMemberId: toFilter(query.authorMemberId),
      after: toDate(query.after),
      before: toDate(query.before),
      threadId: toFilter(query.threadId),
    },
  };
}
