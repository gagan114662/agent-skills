import { describe, it, expect, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import {
  workspaces,
  reachSends,
  reachContacts,
  reachRuns,
  reachReceipts,
} from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { ReachService, type ReachDeps } from "../../src/reach/service.js";
import {
  dbReachContactStore,
  dbReachReceiptStore,
  dbReachRunStore,
  dbReachSendStore,
} from "../../src/db/repositories/reach.js";
import { dbSuppressionStore } from "../../src/db/repositories/acquisition.js";
import { createMockProspectSource } from "../../src/reach/sources/mock.js";
import { createImportedProspectSource } from "../../src/reach/sources/imported.js";
import { createEmailChannel, type EspSender } from "../../src/reach/channels/email.js";
import { createLinkedInChannel } from "../../src/reach/channels/linkedin.js";
import { REACH_DEFAULTS, type ReachCaps } from "../../src/reach/caps.js";
import { createRequest, getRequest } from "../../src/db/repositories/approvals.js";
import { REACH_DATA_CREDIT_ACTION } from "../../src/approvals/policy.js";
import type { ProspectSource } from "../../src/reach/prospect-source.js";
import type { SenderAuthInput } from "../../src/email/deliverability.js";

/**
 * #280 — the Reach outbound loop end-to-end on a real Postgres. Proves the acceptance facts:
 *  - a batch sources live-signal ICP prospects, personalises openers, and AUTO-SENDS a capped, compliant
 *    email batch (recorded-only dry-run sender — no network), recording every attempt;
 *  - the per-domain daily cap bounds the batch (excess → rate_limited, not sent);
 *  - dedupe never re-touches an already-contacted prospect on the next run;
 *  - an external reply is recorded (idempotently) and stops the cadence;
 *  - a PAID data source money-gates the search: it parks a pending #13 `reach.data_credit_spend` request
 *    with the exact amount and sends nothing.
 */
const app = buildApp();
const NOW = new Date(Date.UTC(2026, 5, 16, 15, 0, 0));
const slugs: string[] = [];
const DELIVERABLE_AUTH: SenderAuthInput = {
  spf: { published: true, includesEsp: true },
  dkim: { published: true, verified: true },
  dmarc: { published: true, policy: "reject" },
};

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

async function seed(): Promise<{ workspaceId: string; memberId: string; cookie: string }> {
  const slug = `rc-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "U", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  return { workspaceId: me.workspaceId, memberId: me.memberId, cookie };
}

function caps(over: Partial<ReachCaps> = {}): ReachCaps {
  return {
    ...REACH_DEFAULTS,
    enabled: true,
    brandName: "ipop",
    postalAddress: "1 Market St, San Francisco, CA",
    unsubscribeUrl: "https://ipop.ai/unsubscribe",
    batchSize: 5,
    perDomainDailyCap: 100,
    ...over,
  };
}

/** A service backed by the REAL db repos + the mock (free) source + dry-run email channel. */
function service(
  workspaceId: string,
  memberId: string,
  capsOver: Partial<ReachCaps>,
  source?: ProspectSource,
  sender?: EspSender,
): ReachService {
  const resolveSource: ReachDeps["resolveSource"] = () =>
    source ?? createMockProspectSource({ now: () => NOW.getTime() });
  return new ReachService({
    now: () => NOW,
    icp: {
      async seed() {
        return { domain: "ipop.ai", productKeywords: ["growth"], targetIndustries: ["saas"] };
      },
    },
    resolveSource,
    channels: {
      email: createEmailChannel(sender ? { sender } : undefined),
      linkedin: createLinkedInChannel(),
    },
    contacts: dbReachContactStore,
    sends: dbReachSendStore,
    receipts: dbReachReceiptStore,
    runs: dbReachRunStore,
    suppressions: { loadSuppressed: (w) => dbSuppressionStore.loadSuppressed(w) },
    ...(sender
      ? {
          deliverability: {
            proof: async () => ({
              auth: DELIVERABLE_AUTH,
              authResultsHeader: "spf=pass; dkim=pass; dmarc=pass",
            }),
          },
        }
      : {}),
    caps: () => caps(capsOver),
    approvals: {
      async submitDataCreditSpend(input) {
        const req = await createRequest({
          workspaceId,
          requesterMemberId: memberId,
          actionType: REACH_DATA_CREDIT_ACTION,
          payload: {
            provider: input.provider,
            amountCents: input.amountCents,
            prospectCount: input.prospectCount,
          },
          amount: input.amountCents,
          summary: input.summary,
          status: "pending",
          expiresAt: null,
          events: [{ type: "requested" }],
        });
        return { requestId: req.id };
      },
    },
  });
}

describe("Reach outbound loop on Postgres (#280)", () => {
  it("auto-sends a compliant batch, enrols a cadence, dedupes the next run, records a reply", async () => {
    const { workspaceId, memberId } = await seed();
    const svc = service(workspaceId, memberId, {});

    const run1 = await svc.runBatch(workspaceId);
    expect(run1.status).toBe("completed");
    expect(run1.messagesSent).toBe(5);

    const sent = await db
      .select()
      .from(reachSends)
      .where(and(eq(reachSends.workspaceId, workspaceId), eq(reachSends.status, "sent")));
    expect(sent).toHaveLength(5);
    const enrolled = await db
      .select()
      .from(reachContacts)
      .where(eq(reachContacts.workspaceId, workspaceId));
    expect(enrolled).toHaveLength(5);
    const runs = await db.select().from(reachRuns).where(eq(reachRuns.workspaceId, workspaceId));
    expect(runs[0]?.tuningReport).toBeTruthy();

    // Second run: dedupe — 5 MORE distinct prospects, none repeated.
    const firstKeys = new Set(enrolled.map((c) => c.contactKey));
    const run2 = await svc.runBatch(workspaceId);
    expect(run2.messagesSent).toBe(5);
    const allContacts = await db
      .select()
      .from(reachContacts)
      .where(eq(reachContacts.workspaceId, workspaceId));
    expect(allContacts).toHaveLength(10);
    expect(allContacts.filter((c) => !firstKeys.has(c.contactKey))).toHaveLength(5);

    // Record an external reply on the first contact → receipt persisted + cadence stopped.
    const target = [...firstKeys][0]!;
    const r = await svc.recordReceipt(workspaceId, {
      contactKey: target,
      kind: "reply",
      externalRef: "evt-reply-1",
      replyBody: "Interested, can you send times?",
      replyFrom: "buyer@example.com",
      replySubject: "Re: hello",
    });
    expect(r.recorded).toBe(true);
    const dup = await svc.recordReceipt(workspaceId, {
      contactKey: target,
      kind: "reply",
      externalRef: "evt-reply-1",
    });
    expect(dup.recorded).toBe(false); // idempotent
    const receipts = await db
      .select()
      .from(reachReceipts)
      .where(eq(reachReceipts.workspaceId, workspaceId));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.replyBody).toBe("Interested, can you send times?");
    const threads = await svc.replyThreads(workspaceId);
    expect(threads[0]).toMatchObject({
      contactKey: target,
      replyBody: "Interested, can you send times?",
      replyFrom: "buyer@example.com",
    });
    const stopped = await db
      .select()
      .from(reachContacts)
      .where(and(eq(reachContacts.workspaceId, workspaceId), eq(reachContacts.contactKey, target)));
    expect(stopped[0]?.status).toBe("replied");

    const summary = await svc.summary(workspaceId);
    expect(summary.messagesSent).toBe(10);
    expect(summary.replies).toBe(1);
  });

  it("enforces the per-domain daily cap (excess → rate_limited)", async () => {
    const { workspaceId, memberId } = await seed();
    const svc = service(workspaceId, memberId, { batchSize: 5, perDomainDailyCap: 2 });
    const run = await svc.runBatch(workspaceId);
    expect(run.messagesSent).toBe(2);
    expect(run.rateLimited).toBe(3);
    const rl = await db
      .select()
      .from(reachSends)
      .where(and(eq(reachSends.workspaceId, workspaceId), eq(reachSends.status, "rate_limited")));
    expect(rl).toHaveLength(3);
  });

  it("records a real ESP provider id when the email channel is wired live (#850)", async () => {
    const { workspaceId, memberId } = await seed();
    let n = 0;
    const sender: EspSender = {
      kind: "postmark",
      async send() {
        n += 1;
        return { externalId: `pm-live-${n}` };
      },
    };
    const svc = service(workspaceId, memberId, { batchSize: 2 }, undefined, sender);

    const run = await svc.runBatch(workspaceId);
    expect(run.status).toBe("completed");
    expect(run.messagesSent).toBe(2);

    const sent = await db
      .select()
      .from(reachSends)
      .where(and(eq(reachSends.workspaceId, workspaceId), eq(reachSends.status, "sent")));
    expect(sent).toHaveLength(2);
    expect(sent.map((s) => s.externalId)).toEqual(["pm-live-1", "pm-live-2"]);
    expect(sent.every((s) => !s.externalId?.startsWith("dryrun-"))).toBe(true);
  });

  it("imports real prospects through the self-serve route and uses them as the default source (#895)", async () => {
    const { workspaceId, memberId, cookie } = await seed();
    const prospects = Array.from({ length: 10 }, (_, i) => ({
      fullName: `Buyer ${i}`,
      title: "Founder",
      company: `ImportedCo ${i}`,
      companyDomain: `imported${i}.com`,
      email: `buyer${i}@imported${i}.com`,
      industry: "saas",
      companySize: "11-50",
      signalKind: "funding_round",
      signalSummary: "raised a seed round",
      observedAtMs: NOW.getTime(),
    }));

    const imported = await app.inject({
      method: "POST",
      url: "/me/reach/import-prospects",
      cookies: { rid: cookie },
      payload: { prospects },
    });
    expect(imported.statusCode).toBe(201);
    expect(imported.json()).toMatchObject({ imported: 10, updated: 0, skipped: 0 });

    const queued = await db
      .select()
      .from(reachContacts)
      .where(and(eq(reachContacts.workspaceId, workspaceId), eq(reachContacts.status, "imported")));
    expect(queued).toHaveLength(10);

    const importedSource = createImportedProspectSource(workspaceId, {
      loadImportedProspects: ({ workspaceId, limit, excludeKeys }) =>
        dbReachContactStore.importedProspects(workspaceId, limit, excludeKeys),
    });
    const svc = service(
      workspaceId,
      memberId,
      { batchSize: 10, prospectSource: "imported" },
      importedSource,
    );
    const run = await svc.runBatch(workspaceId);
    expect(run.status).toBe("completed");
    expect(run.prospectsFound).toBe(10);
    expect(run.messagesSent).toBe(10);

    const enrolled = await db
      .select()
      .from(reachContacts)
      .where(and(eq(reachContacts.workspaceId, workspaceId), eq(reachContacts.status, "active")));
    expect(enrolled).toHaveLength(10);
  });

  it("money-gates a paid prospect source: parks a pending #13 spend, sends nothing", async () => {
    const { workspaceId, memberId } = await seed();
    const paid: ProspectSource = {
      kind: "clay",
      paid: true,
      estimateCostCents: (limit) => limit * 5,
      async search() {
        throw new Error("must not search before approval");
      },
    };
    const svc = service(workspaceId, memberId, { batchSize: 10, prospectSource: "clay" }, paid);
    const run = await svc.runBatch(workspaceId);
    expect(run.status).toBe("awaiting_data_funding");
    expect(run.approvalRequestId).toBeTruthy();

    const req = await getRequest(run.approvalRequestId!);
    expect(req?.actionType).toBe(REACH_DATA_CREDIT_ACTION);
    expect(req?.status).toBe("pending");
    expect(req?.amount).toBe(50); // 10 prospects × 5c
    const sent = await db.select().from(reachSends).where(eq(reachSends.workspaceId, workspaceId));
    expect(sent).toHaveLength(0); // nothing sent
  });
});
