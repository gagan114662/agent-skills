import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { ReachService, type ImportedProspectInput } from "../reach/service.js";
import { isReachReceiptKind, isReachSignalKind } from "../reach/types.js";

/**
 * Reach routes (#280) under `/me/reach/*` — thin adapters over {@link ReachService}, scoped to the caller's
 * workspace (#3).
 *
 *  - `POST /me/reach/run` runs ONE batch of the outbound loop now (the cron entrypoint — an external
 *    scheduler hits this on an interval, or an owner triggers it manually). Pass `{ "mode": "live" }` or
 *    `{ "requireLive": true }` from production/autonomous surfaces so mock/dry-run setups fail closed before
 *    ipop claims agents are reaching out. Demo callers may omit it to exercise the dry-run pipeline.
 *    It auto-sends within the per-domain cap + suppression; a PAID data source parks a money-gated #13 request instead of spending.
 *  - `GET /me/reach/preflight` returns the same live/autonomous truth gate for UI badges and schedulers.
 *  - `POST /me/reach/receipts` records an external engagement receipt (open/reply/booked) — the only
 *    source of measurement truth; a reply stops that prospect's cadence.
 *  - `GET /me/reach/summary` returns the headline numbers (prospects reached, sent, replies, booked).
 *
 * Running a batch is NOT money (sending a marketing message is autonomous under the caps), so these
 * carry no #13 gate; the only money path (buying paid data credits) is gated inside the service.
 */
export interface ReachRoutesOptions {
  service: ReachService;
}

const IMPORT_LIMIT = 500;

function textField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function prospectFromRecord(record: Record<string, unknown>): ImportedProspectInput | null {
  const fullName = textField(record.fullName ?? record.name);
  const company = textField(record.company);
  const email = textField(record.email);
  const linkedinUrl = textField(record.linkedinUrl ?? record.linkedin);
  if (!fullName || !company || (!email && !linkedinUrl)) return null;
  const signalKindRaw = textField(record.signalKind ?? record.signal);
  const observedAt = record.observedAtMs;
  return {
    fullName,
    company,
    title: textField(record.title),
    companyDomain: textField(record.companyDomain ?? record.domain),
    email,
    linkedinUrl,
    industry: textField(record.industry),
    companySize: textField(record.companySize),
    signalKind: signalKindRaw && isReachSignalKind(signalKindRaw) ? signalKindRaw : null,
    signalSummary: textField(record.signalSummary),
    observedAtMs: typeof observedAt === "number" && Number.isFinite(observedAt) ? observedAt : null,
  };
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === '"' && line[i + 1] === '"') {
      cur += '"';
      i += 1;
    } else if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function prospectsFromCsv(csv: string): ImportedProspectInput[] {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const [header, ...rows] = lines;
  if (!header) return [];
  const headers = splitCsvLine(header).map((h) => h.trim());
  return rows.flatMap((line) => {
    const cells = splitCsvLine(line);
    const rec: Record<string, unknown> = {};
    headers.forEach((h, i) => { rec[h] = cells[i] ?? ""; });
    const prospect = prospectFromRecord(rec);
    return prospect ? [prospect] : [];
  });
}

function prospectsFromBody(body: unknown): ImportedProspectInput[] {
  const b = (body ?? {}) as { prospects?: unknown; csv?: unknown };
  if (typeof b.csv === "string") return prospectsFromCsv(b.csv).slice(0, IMPORT_LIMIT);
  if (!Array.isArray(b.prospects)) return [];
  return b.prospects
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const prospect = prospectFromRecord(item as Record<string, unknown>);
      return prospect ? [prospect] : [];
    })
    .slice(0, IMPORT_LIMIT);
}

export async function reachRoutes(app: FastifyInstance, opts: ReachRoutesOptions): Promise<void> {
  const { service } = opts;

  app.post("/me/reach/run", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const body = (req.body ?? {}) as { requireLive?: unknown; mode?: unknown };
    const requireLive = body.requireLive === true || body.mode === "live";
    if (requireLive) return service.runLiveBatch(id.workspaceId);
    return service.runBatch(id.workspaceId);
  });

  app.get("/me/reach/preflight", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    return service.livePreflight(id.workspaceId);
  });

  app.get("/me/reach/summary", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    return service.summary(id.workspaceId);
  });

  app.post("/me/reach/import-prospects", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const prospects = prospectsFromBody(req.body);
    if (prospects.length === 0) {
      return reply.code(400).send({ error: "provide prospects[] or csv with fullName/name, company, and email/linkedin" });
    }
    const result = await service.importProspects(id.workspaceId, prospects);
    return reply.code(201).send(result);
  });

  app.get("/me/reach/replies", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    return { replies: await service.replyThreads(id.workspaceId) };
  });

  app.post("/me/reach/receipts", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const body = (req.body ?? {}) as {
      contactKey?: unknown;
      kind?: unknown;
      externalRef?: unknown;
      replyBody?: unknown;
      replyFrom?: unknown;
      replySubject?: unknown;
      occurredAt?: unknown;
    };
    if (!body.contactKey || !body.kind || !body.externalRef) {
      return reply.code(400).send({ error: "contactKey, kind, and externalRef are required" });
    }
    if (
      typeof body.contactKey !== "string" ||
      typeof body.kind !== "string" ||
      typeof body.externalRef !== "string"
    ) {
      return reply.code(400).send({ error: "contactKey, kind, and externalRef must be strings" });
    }
    if (!isReachReceiptKind(body.kind)) {
      return reply.code(400).send({ error: "kind must be one of open|reply|booked" });
    }
    const occurredAt =
      typeof body.occurredAt === "string" || typeof body.occurredAt === "number"
        ? new Date(body.occurredAt)
        : undefined;
    return service.recordReceipt(id.workspaceId, {
      contactKey: body.contactKey,
      kind: body.kind,
      externalRef: body.externalRef,
      replyBody: typeof body.replyBody === "string" ? body.replyBody : null,
      replyFrom: typeof body.replyFrom === "string" ? body.replyFrom : null,
      replySubject: typeof body.replySubject === "string" ? body.replySubject : null,
      occurredAt: occurredAt && !Number.isNaN(occurredAt.getTime()) ? occurredAt : undefined,
    });
  });
}
