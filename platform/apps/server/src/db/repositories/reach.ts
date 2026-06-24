import { and, count, desc, eq, gte, ne } from "drizzle-orm";
import { db } from "../index.js";
import { reachContacts, reachReceipts, reachRuns, reachSends } from "../schema/index.js";
import type {
  ActiveEnrollment,
  ImportedProspectInput,
  ReachContactStore,
  ReachReceiptStore,
  ReachRunStore,
  ReachSendStore,
} from "../../reach/service.js";
import type { ReceiptDatum, SendDatum } from "../../reach/measure.js";
import type { RawProspect, ReachChannel, ReachReceiptKind, ReachSendStatus, ReachSignalKind, ReachVariant } from "../../reach/types.js";
import { isReachSignalKind, type ReachRunStatus } from "../../reach/types.js";
import type { ReachTuningConfig } from "../../reach/self-tune.js";

/**
 * Reach repositories (#280) — implement the store seams `ReachService` reads/writes through. Tenant-scoped
 * throughout (#3). Dedupe is the `(workspace_id, contact_key)` unique index on `reach_contacts`; the
 * receipt insert is idempotent via the `(workspace_id, send_id, kind, external_ref)` unique index.
 */

function toSignalKind(value: string | null): ReachSignalKind | null {
  return value && isReachSignalKind(value) ? value : null;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function contactKey(input: Pick<ImportedProspectInput, "email" | "linkedinUrl" | "fullName" | "company">): string | null {
  const email = clean(input.email)?.toLowerCase();
  if (email) return `email:${email}`;
  const linkedin = clean(input.linkedinUrl)?.toLowerCase();
  if (linkedin) return `linkedin:${linkedin}`;
  const fullName = clean(input.fullName)?.toLowerCase();
  const company = clean(input.company)?.toLowerCase();
  if (fullName && company) return `id:${fullName}|${company}`;
  return null;
}

function importedSignals(input: ImportedProspectInput, fallbackMs: number): RawProspect["signals"] {
  if (!input.signalKind || !isReachSignalKind(input.signalKind)) return [];
  return [{
    kind: input.signalKind,
    summary: clean(input.signalSummary) ?? "Imported prospect",
    observedAtMs: input.observedAtMs && Number.isFinite(input.observedAtMs) ? input.observedAtMs : fallbackMs,
  }];
}

function rawSignals(value: unknown): RawProspect["signals"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const rec = item as { kind?: unknown; summary?: unknown; observedAtMs?: unknown };
    if (typeof rec.kind !== "string" || !isReachSignalKind(rec.kind)) return [];
    return [{
      kind: rec.kind,
      summary: typeof rec.summary === "string" && rec.summary.trim() ? rec.summary.trim() : "Imported prospect",
      observedAtMs: typeof rec.observedAtMs === "number" && Number.isFinite(rec.observedAtMs) ? rec.observedAtMs : Date.now(),
    }];
  });
}

export const dbReachContactStore: ReachContactStore = {
  async contactedKeys(workspaceId: string): Promise<Set<string>> {
    const rows = await db
      .select({ contactKey: reachContacts.contactKey })
      .from(reachContacts)
      .where(and(eq(reachContacts.workspaceId, workspaceId), ne(reachContacts.status, "imported")));
    return new Set(rows.map((r) => r.contactKey));
  },
  async importProspects(workspaceId, prospects, now): Promise<{ imported: number; updated: number; skipped: number }> {
    let imported = 0;
    let updated = 0;
    let skipped = 0;
    for (const prospect of prospects) {
      const key = contactKey(prospect);
      const fullName = clean(prospect.fullName);
      const company = clean(prospect.company);
      if (!key || !fullName || !company) {
        skipped += 1;
        continue;
      }
      const [existing] = await db
        .select({ id: reachContacts.id })
        .from(reachContacts)
        .where(and(eq(reachContacts.workspaceId, workspaceId), eq(reachContacts.contactKey, key)))
        .limit(1);
      const channel: ReachChannel = clean(prospect.email) ? "email" : "linkedin";
      await db
        .insert(reachContacts)
        .values({
          workspaceId,
          contactKey: key,
          recipientLabel: `${fullName} · ${company}`,
          channel,
          status: "imported",
          currentStep: 0,
          lastStepAt: null,
          score: 0,
          signalKind: prospect.signalKind && isReachSignalKind(prospect.signalKind) ? prospect.signalKind : null,
          fullName,
          title: clean(prospect.title),
          company,
          companyDomain: clean(prospect.companyDomain),
          email: clean(prospect.email)?.toLowerCase() ?? null,
          linkedinUrl: clean(prospect.linkedinUrl),
          industry: clean(prospect.industry),
          companySize: clean(prospect.companySize),
          signals: importedSignals(prospect, now.getTime()),
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [reachContacts.workspaceId, reachContacts.contactKey],
          set: {
            recipientLabel: `${fullName} · ${company}`,
            channel,
            fullName,
            title: clean(prospect.title),
            company,
            companyDomain: clean(prospect.companyDomain),
            email: clean(prospect.email)?.toLowerCase() ?? null,
            linkedinUrl: clean(prospect.linkedinUrl),
            industry: clean(prospect.industry),
            companySize: clean(prospect.companySize),
            signals: importedSignals(prospect, now.getTime()),
            updatedAt: now,
          },
        });
      if (existing) updated += 1;
      else imported += 1;
    }
    return { imported, updated, skipped };
  },
  async importedProspects(workspaceId, limit, excludeKeys): Promise<RawProspect[]> {
    const rows = await db
      .select()
      .from(reachContacts)
      .where(and(eq(reachContacts.workspaceId, workspaceId), eq(reachContacts.status, "imported")))
      .orderBy(desc(reachContacts.updatedAt))
      .limit(Math.max(1, limit * 3));
    const prospects: RawProspect[] = [];
    for (const row of rows) {
      if (prospects.length >= limit) break;
      if (excludeKeys.has(row.contactKey)) continue;
      if (!row.fullName || !row.company || (!row.email && !row.linkedinUrl)) continue;
      prospects.push({
        fullName: row.fullName,
        title: row.title ?? "",
        company: row.company,
        companyDomain: row.companyDomain ?? "",
        email: row.email,
        linkedinUrl: row.linkedinUrl,
        industry: row.industry,
        companySize: row.companySize,
        signals: rawSignals(row.signals),
        sourceKind: "imported",
      });
    }
    return prospects;
  },
  async upsertEnrollment(input): Promise<void> {
    await db
      .insert(reachContacts)
      .values({
        workspaceId: input.workspaceId,
        contactKey: input.contactKey,
        recipientLabel: input.recipientLabel,
        channel: input.channel,
        status: input.enrollment.status,
        currentStep: input.enrollment.currentStep,
        lastStepAt: input.enrollment.lastStepAtMs ? new Date(input.enrollment.lastStepAtMs) : null,
        score: input.score,
        signalKind: input.signalKind,
      })
      .onConflictDoUpdate({
        target: [reachContacts.workspaceId, reachContacts.contactKey],
        set: {
          status: input.enrollment.status,
          currentStep: input.enrollment.currentStep,
          lastStepAt: input.enrollment.lastStepAtMs ? new Date(input.enrollment.lastStepAtMs) : null,
          score: input.score,
          signalKind: input.signalKind,
          updatedAt: new Date(),
        },
      });
  },
  async markStatus(workspaceId, contactKey, status): Promise<void> {
    await db
      .update(reachContacts)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(reachContacts.workspaceId, workspaceId), eq(reachContacts.contactKey, contactKey)));
  },
  async activeEnrollments(workspaceId): Promise<ActiveEnrollment[]> {
    const rows = await db
      .select({
        contactKey: reachContacts.contactKey,
        recipientLabel: reachContacts.recipientLabel,
        channel: reachContacts.channel,
        currentStep: reachContacts.currentStep,
        lastStepAt: reachContacts.lastStepAt,
        score: reachContacts.score,
        signalKind: reachContacts.signalKind,
      })
      .from(reachContacts)
      .where(and(eq(reachContacts.workspaceId, workspaceId), eq(reachContacts.status, "active")));
    return rows.map((r) => ({
      contactKey: r.contactKey,
      recipientLabel: r.recipientLabel,
      channel: r.channel as ReachChannel,
      currentStep: r.currentStep,
      lastStepAtMs: r.lastStepAt ? r.lastStepAt.getTime() : 0,
      score: r.score,
      signalKind: r.signalKind,
    }));
  },
};

export const dbReachSendStore: ReachSendStore = {
  async countSentSince(workspaceId, since): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(reachSends)
      .where(
        and(
          eq(reachSends.workspaceId, workspaceId),
          eq(reachSends.status, "sent"),
          gte(reachSends.createdAt, since),
        ),
      );
    return Number(row?.n ?? 0);
  },
  async insert(input): Promise<{ id: string }> {
    const [row] = await db
      .insert(reachSends)
      .values({
        workspaceId: input.workspaceId,
        contactKey: input.contactKey,
        channel: input.channel,
        status: input.status,
        variant: input.variant,
        signalKind: input.signalKind,
        subject: input.subject,
        externalId: input.externalId,
        sentHourUtc: input.sentHourUtc,
        detail: input.detail,
      })
      .returning({ id: reachSends.id });
    if (!row) throw new Error("reach send insert returned no row");
    return { id: row.id };
  },
  async latestSendId(workspaceId, contactKey): Promise<string | null> {
    const [row] = await db
      .select({ id: reachSends.id })
      .from(reachSends)
      .where(and(eq(reachSends.workspaceId, workspaceId), eq(reachSends.contactKey, contactKey)))
      .orderBy(desc(reachSends.createdAt))
      .limit(1);
    return row?.id ?? null;
  },
  async findByExternalId(workspaceId, externalId): Promise<{ id: string; contactKey: string } | null> {
    const [row] = await db
      .select({ id: reachSends.id, contactKey: reachSends.contactKey })
      .from(reachSends)
      .where(and(eq(reachSends.workspaceId, workspaceId), eq(reachSends.externalId, externalId)))
      .orderBy(desc(reachSends.createdAt))
      .limit(1);
    return row ?? null;
  },
  async sendsSince(workspaceId, since): Promise<SendDatum[]> {
    const rows = await db
      .select({
        channel: reachSends.channel,
        status: reachSends.status,
        variant: reachSends.variant,
        signalKind: reachSends.signalKind,
        sentHourUtc: reachSends.sentHourUtc,
      })
      .from(reachSends)
      .where(and(eq(reachSends.workspaceId, workspaceId), gte(reachSends.createdAt, since)));
    return rows.map((r) => ({
      channel: r.channel as ReachChannel,
      status: r.status as ReachSendStatus,
      variant: r.variant as ReachVariant,
      signalKind: toSignalKind(r.signalKind),
      sentHourUtc: r.sentHourUtc,
    }));
  },
};

/** Resolve a Reach contact's current email address from its stable contact key. Tenant-scoped. */
export async function getReachContactEmail(workspaceId: string, contactKey: string): Promise<string | null> {
  const [row] = await db
    .select({ email: reachContacts.email })
    .from(reachContacts)
    .where(and(eq(reachContacts.workspaceId, workspaceId), eq(reachContacts.contactKey, contactKey)))
    .limit(1);
  return clean(row?.email) ? row!.email!.trim().toLowerCase() : null;
}

export const dbReachReceiptStore: ReachReceiptStore = {
  async record(input): Promise<{ recorded: boolean }> {
    const rows = await db
      .insert(reachReceipts)
      .values({
        workspaceId: input.workspaceId,
        sendId: input.sendId,
        contactKey: input.contactKey,
        kind: input.kind,
        externalRef: input.externalRef,
        replyBody: input.replyBody ?? null,
        replyFrom: input.replyFrom ?? null,
        replySubject: input.replySubject ?? null,
        occurredAt: input.occurredAt,
      })
      .onConflictDoNothing({
        target: [reachReceipts.workspaceId, reachReceipts.sendId, reachReceipts.kind, reachReceipts.externalRef],
      })
      .returning({ id: reachReceipts.id });
    return { recorded: rows.length > 0 };
  },
  async receiptData(workspaceId, since): Promise<ReceiptDatum[]> {
    const rows = await db
      .select({
        kind: reachReceipts.kind,
        variant: reachSends.variant,
        signalKind: reachSends.signalKind,
        sentHourUtc: reachSends.sentHourUtc,
      })
      .from(reachReceipts)
      .innerJoin(reachSends, eq(reachReceipts.sendId, reachSends.id))
      .where(and(eq(reachReceipts.workspaceId, workspaceId), gte(reachReceipts.createdAt, since)));
    return rows.map((r) => ({
      kind: r.kind as ReachReceiptKind,
      variant: r.variant as ReachVariant,
      signalKind: toSignalKind(r.signalKind),
      sentHourUtc: r.sentHourUtc,
    }));
  },
  async replyThreads(workspaceId, limit = 50) {
    const rows = await db
      .select({
        receiptId: reachReceipts.id,
        sendId: reachReceipts.sendId,
        contactKey: reachReceipts.contactKey,
        externalRef: reachReceipts.externalRef,
        replyBody: reachReceipts.replyBody,
        replyFrom: reachReceipts.replyFrom,
        replySubject: reachReceipts.replySubject,
        occurredAt: reachReceipts.occurredAt,
        createdAt: reachReceipts.createdAt,
      })
      .from(reachReceipts)
      .where(and(eq(reachReceipts.workspaceId, workspaceId), eq(reachReceipts.kind, "reply")))
      .orderBy(desc(reachReceipts.occurredAt))
      .limit(limit);
    return rows;
  },
};

/**
 * Founder-console proof reading (#280, #253): the Reach tile's numbers in one query set — messages SENT
 * (the headline metric + trend), prospects reached (distinct enrolled contacts), and external replies +
 * meetings. All grounded in real rows (sends + receipts), never fabricated.
 */
export async function reachProofReading(
  workspaceId: string,
  since: Date,
): Promise<{ sentAll: number; sentSince: number; prospects: number; replies: number; booked: number }> {
  const [sentAllRow, sentSinceRow, prospectsRow, replyRow, bookedRow] = await Promise.all([
    db
      .select({ n: count() })
      .from(reachSends)
      .where(and(eq(reachSends.workspaceId, workspaceId), eq(reachSends.status, "sent"))),
    db
      .select({ n: count() })
      .from(reachSends)
      .where(and(eq(reachSends.workspaceId, workspaceId), eq(reachSends.status, "sent"), gte(reachSends.createdAt, since))),
    db.select({ n: count() }).from(reachContacts).where(eq(reachContacts.workspaceId, workspaceId)),
    db
      .select({ n: count() })
      .from(reachReceipts)
      .where(and(eq(reachReceipts.workspaceId, workspaceId), eq(reachReceipts.kind, "reply"))),
    db
      .select({ n: count() })
      .from(reachReceipts)
      .where(and(eq(reachReceipts.workspaceId, workspaceId), eq(reachReceipts.kind, "booked"))),
  ]);
  return {
    sentAll: Number(sentAllRow[0]?.n ?? 0),
    sentSince: Number(sentSinceRow[0]?.n ?? 0),
    prospects: Number(prospectsRow[0]?.n ?? 0),
    replies: Number(replyRow[0]?.n ?? 0),
    booked: Number(bookedRow[0]?.n ?? 0),
  };
}

export const dbReachRunStore: ReachRunStore = {
  async insert(input): Promise<{ id: string }> {
    const [row] = await db
      .insert(reachRuns)
      .values({
        workspaceId: input.workspaceId,
        sourceKind: input.sourceKind,
        status: input.status,
        prospectsFound: input.prospectsFound,
        messagesSent: input.messagesSent,
        messagesQueued: input.messagesQueued,
        suppressedCount: input.suppressedCount,
        rateLimitedCount: input.rateLimitedCount,
        tuningReport: input.tuningReport ?? undefined,
      })
      .returning({ id: reachRuns.id });
    if (!row) throw new Error("reach run insert returned no row");
    return { id: row.id };
  },
  async latestTuning(workspaceId): Promise<ReachTuningConfig | null> {
    const [row] = await db
      .select({ status: reachRuns.status, tuningReport: reachRuns.tuningReport })
      .from(reachRuns)
      .where(and(eq(reachRuns.workspaceId, workspaceId), eq(reachRuns.status, "completed" satisfies ReachRunStatus)))
      .orderBy(desc(reachRuns.createdAt))
      .limit(1);
    const report = row?.tuningReport as { next?: ReachTuningConfig } | null | undefined;
    return report?.next ?? null;
  },
};
