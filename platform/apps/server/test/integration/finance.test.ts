import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces, revenueEvents, financeLedgerEntries } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { createDefaultFinanceService } from "../../src/finance/default.js";

const app = buildApp();
const slugs: string[] = [];
const PREV = process.env.RELOAD_FINANCE_ENABLED;

beforeAll(() => {
  // Opt the finance layer in for the whole test process (owner-workspace-first env opt-in).
  process.env.RELOAD_FINANCE_ENABLED = "true";
});

afterAll(async () => {
  if (PREV === undefined) delete process.env.RELOAD_FINANCE_ENABLED;
  else process.env.RELOAD_FINANCE_ENABLED = PREV;
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

const get = (url: string, cookie: string) => app.inject({ method: "GET", url, cookies: { rid: cookie } });

async function seed(): Promise<{ cookie: string; workspaceId: string }> {
  const slug = `fin-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "U", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await get("/me", cookie)).json();
  return { cookie, workspaceId: me.workspaceId };
}

describe("finance ledger routes (integration, real Postgres)", () => {
  it("returns 409 when finance is not enabled for the workspace", async () => {
    delete process.env.RELOAD_FINANCE_ENABLED;
    const { cookie, workspaceId } = await seed();
    const res = await get(`/workspaces/${workspaceId}/finance/ledger`, cookie);
    expect(res.statusCode).toBe(409);
    process.env.RELOAD_FINANCE_ENABLED = "true";
  });

  it("posts an external Stripe receipt into the ledger and serves the close pack + runway + CSV", async () => {
    const { cookie, workspaceId } = await seed();

    // An external, verified inbound payment receipt (#98 revenue_events).
    await db.insert(revenueEvents).values({
      workspaceId,
      provider: "stripe",
      providerEventId: `evt_${newId()}`,
      type: "checkout.session.completed",
      amountCents: 12000,
      currency: "usd",
      status: "paid",
    });

    // Drive the posting/close the engine would run (idempotent).
    const svc = createDefaultFinanceService();
    await svc.sync(workspaceId);
    await svc.close(workspaceId);

    // The ledger carries one verified credit, attributed to no venture (workspace-level).
    const ledger = (await get(`/workspaces/${workspaceId}/finance/ledger`, cookie)).json();
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({ direction: "credit", verified: true, amountCents: 12000, source: "stripe_event" });

    // Re-syncing does not double-count (idempotent upsert).
    await svc.sync(workspaceId);
    const rows = await db.select().from(financeLedgerEntries).where(eq(financeLedgerEntries.workspaceId, workspaceId));
    expect(rows).toHaveLength(1);

    // The closed book reports the revenue with full external-receipt verification.
    const close = (await get(`/workspaces/${workspaceId}/finance/close`, cookie)).json();
    expect(close.closePacks.length).toBeGreaterThanOrEqual(1);
    const ws = close.closePacks.find((p: { ventureIdeaId: string | null }) => p.ventureIdeaId === null);
    expect(ws).toMatchObject({ revenueCents: 12000, verifiedShareBps: 10000 });

    // Runway is healthy (revenue, no burn) and the CSV statement renders for the accountant.
    const runway = (await get(`/workspaces/${workspaceId}/finance/runway`, cookie)).json();
    expect(runway.health).toBe("healthy");

    const csv = await get(`/workspaces/${workspaceId}/finance/export.csv`, cookie);
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body).toContain("120.00");
  });

  it("is tenant-scoped — a caller cannot read another workspace's books", async () => {
    const a = await seed();
    const b = await seed();
    const res = await get(`/workspaces/${b.workspaceId}/finance/ledger`, a.cookie);
    expect(res.statusCode).toBe(403);
  });
});
