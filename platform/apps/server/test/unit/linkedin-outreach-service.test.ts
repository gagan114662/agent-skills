/**
 * Unit tests for the LinkedIn outreach service (#595) over the in-memory store and a controllable provider.
 * Exercises the full contract — draft (no send) → approval-gated send → daily-limit enforcement → send-now /
 * error — plus the disabled no-op, the no-credentials no-op (via the real adapter), workspace (IDOR) scoping,
 * and the single-use send guard.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  LinkedInOutreachService,
  LinkedInOutreachError,
} from "../../src/linkedin-outreach/service.js";
import { InMemoryOutreachStore } from "../../src/linkedin-outreach/store.js";
import { createRealProvider } from "../../src/linkedin-outreach/provider.js";
import { LINKEDIN_OUTREACH_DEFAULTS, type LinkedInOutreachCaps } from "../../src/linkedin-outreach/caps.js";
import { getPlan, type Plan } from "../../src/billing/plans.js";
import type {
  OutreachContext,
  OutreachProvider,
  Prospect,
  ProviderSendInput,
  ProviderSendResult,
} from "../../src/linkedin-outreach/types.js";

const WID = "ws-1";
const OTHER_WID = "ws-2";
const APPROVAL = "approval-abc";
const T0 = new Date("2026-01-01T12:00:00.000Z");

const PROSPECT: Prospect = { ref: "urn:li:person:1", name: "Dana Lopez", company: "Acme", title: "VP Eng" };
const CONTEXT: OutreachContext = {
  senderName: "Sam",
  senderCompany: "ipop",
  valueProposition: "a teardown of onboarding wins",
};

/** A provider that records every call and returns a scripted result; lets a test assert "never called". */
class SpyProvider implements OutreachProvider {
  calls: ProviderSendInput[] = [];
  constructor(
    private readonly result: ProviderSendResult | (() => ProviderSendResult) = {
      status: "sent",
      externalId: "ext-1",
    },
  ) {}
  async send(input: ProviderSendInput): Promise<ProviderSendResult> {
    this.calls.push(input);
    return typeof this.result === "function" ? this.result() : this.result;
  }
}

interface Built {
  service: LinkedInOutreachService;
  store: InMemoryOutreachStore;
  provider: SpyProvider;
}

function build(opts: {
  enabled?: boolean;
  caps?: Partial<LinkedInOutreachCaps>;
  provider?: OutreachProvider;
  plan?: Plan | null;
  now?: () => Date;
} = {}): Built {
  const store = new InMemoryOutreachStore();
  const provider = (opts.provider as SpyProvider) ?? new SpyProvider();
  const caps: LinkedInOutreachCaps = {
    ...LINKEDIN_OUTREACH_DEFAULTS,
    enabled: opts.enabled ?? true,
    ...opts.caps,
  };
  const service = new LinkedInOutreachService({
    store,
    provider,
    caps,
    planForWorkspace: opts.plan === undefined ? undefined : async () => opts.plan,
    now: opts.now ?? (() => T0),
  });
  return { service, store, provider };
}

async function draftOne(b: Built, over: Partial<Parameters<LinkedInOutreachService["draft"]>[0]> = {}) {
  const { touch } = await b.service.draft({
    workspaceId: WID,
    kind: "connection",
    prospect: PROSPECT,
    context: CONTEXT,
    ...over,
  });
  return touch;
}

describe("LinkedInOutreachService (#595)", () => {
  let b: Built;
  beforeEach(() => {
    b = build();
  });

  it("draft composes a body, creates a drafted touch, and sends nothing", async () => {
    const { touch, draft } = await b.service.draft({
      workspaceId: WID,
      kind: "connection",
      prospect: PROSPECT,
      context: CONTEXT,
    });
    expect(touch.status).toBe("drafted");
    expect(touch.body).toBe(draft.body);
    expect(touch.body.length).toBeGreaterThan(0);
    expect(touch.prospectRef).toBe(PROSPECT.ref);
    expect(touch.prospect.name).toBe("Dana Lopez");
    expect(touch.externalId).toBeNull();
    expect(touch.approvalRequestId).toBeNull();
    expect(b.provider.calls).toHaveLength(0);
  });

  it("draft rejects an unknown kind and a missing prospect ref", async () => {
    await expect(
      b.service.draft({
        workspaceId: WID,
        // @ts-expect-error intentionally invalid kind
        kind: "carrier-pigeon",
        prospect: PROSPECT,
        context: CONTEXT,
      }),
    ).rejects.toBeInstanceOf(LinkedInOutreachError);
    await expect(draftOne(b, { prospect: { ref: "  ", name: "X" } })).rejects.toBeInstanceOf(
      LinkedInOutreachError,
    );
  });

  it("send refuses without an approval id (never auto-sends)", async () => {
    const touch = await draftOne(b);
    await expect(b.service.send(WID, touch.id, { approvalRequestId: "" })).rejects.toThrow(
      /approved item/,
    );
    expect(b.provider.calls).toHaveLength(0);
  });

  it("send-now records sent + external id via the provider and forwards the credential", async () => {
    const built = build({ caps: { credential: "tok-9" } });
    const touch = await draftOne(built);
    const out = await built.service.send(WID, touch.id, { approvalRequestId: APPROVAL });
    expect(out.status).toBe("sent");
    expect(out.externalId).toBe("ext-1");
    expect(out.approvalRequestId).toBe(APPROVAL);
    expect(built.provider.calls).toHaveLength(1);
    expect(built.provider.calls[0]?.credential).toBe("tok-9");
    expect(built.provider.calls[0]?.body).toBe(touch.body);
  });

  it("disabled connector is an inert no-op: provider untouched, touch stays drafted", async () => {
    const built = build({ enabled: false });
    const touch = await draftOne(built);
    const out = await built.service.send(WID, touch.id, { approvalRequestId: APPROVAL });
    expect(out.status).toBe("drafted");
    expect(out.externalId).toBeNull();
    expect(built.provider.calls).toHaveLength(0);
  });

  it("enforces the daily send limit: refuses past the cap, leaving the touch drafted", async () => {
    const built = build({ caps: { dailySendLimit: 2 } });
    // Two sends succeed.
    for (let i = 0; i < 2; i++) {
      const t = await draftOne(built, { prospect: { ...PROSPECT, ref: `p-${i}` } });
      const out = await built.service.send(WID, t.id, { approvalRequestId: APPROVAL });
      expect(out.status).toBe("sent");
    }
    // The third is over the cap.
    const third = await draftOne(built, { prospect: { ...PROSPECT, ref: "p-3" } });
    await expect(
      built.service.send(WID, third.id, { approvalRequestId: APPROVAL }),
    ).rejects.toThrow(/daily outreach limit reached/);
    // It is NOT sent — still drafted, and the provider was not called the third time.
    expect((await built.service.get(WID, third.id))?.status).toBe("drafted");
    expect(built.provider.calls).toHaveLength(2);
  });

  it("enforces the active plan's daily outreach quota before provider calls (#1290)", async () => {
    const starter = getPlan("starter")!;
    const built = build({ caps: { dailySendLimit: 999 }, plan: starter });
    for (let i = 0; i < starter.productLimits.dailyOutreachSends; i++) {
      const t = await draftOne(built, { prospect: { ...PROSPECT, ref: `plan-${i}` } });
      await built.service.send(WID, t.id, { approvalRequestId: APPROVAL });
    }
    const over = await draftOne(built, { prospect: { ...PROSPECT, ref: "plan-over" } });
    await expect(built.service.send(WID, over.id, { approvalRequestId: APPROVAL })).rejects.toThrow(
      /daily outreach plan limit reached/,
    );
    expect((await built.service.get(WID, over.id))?.status).toBe("drafted");
    expect(built.provider.calls).toHaveLength(starter.productLimits.dailyOutreachSends);
  });

  it("the daily limit is per-workspace (one tenant's sends do not consume another's budget)", async () => {
    const built = build({ caps: { dailySendLimit: 1 } });
    const a = await draftOne(built);
    await built.service.send(WID, a.id, { approvalRequestId: APPROVAL });
    // A different workspace still has its full budget.
    const { touch: other } = await built.service.draft({
      workspaceId: OTHER_WID,
      kind: "connection",
      prospect: PROSPECT,
      context: CONTEXT,
    });
    const out = await built.service.send(OTHER_WID, other.id, { approvalRequestId: APPROVAL });
    expect(out.status).toBe("sent");
  });

  it("remainingToday reflects the cap minus today's sends", async () => {
    const built = build({ caps: { dailySendLimit: 3 } });
    expect(await built.service.remainingToday(WID)).toBe(3);
    const t = await draftOne(built);
    await built.service.send(WID, t.id, { approvalRequestId: APPROVAL });
    expect(await built.service.remainingToday(WID)).toBe(2);
  });

  it("remainingToday uses the active plan quota when one exists (#1290)", async () => {
    const pro = getPlan("pro")!;
    const built = build({ caps: { dailySendLimit: 1 }, plan: pro });
    expect(await built.service.remainingToday(WID)).toBe(pro.productLimits.dailyOutreachSends);
    const t = await draftOne(built);
    await built.service.send(WID, t.id, { approvalRequestId: APPROVAL });
    expect(await built.service.remainingToday(WID)).toBe(pro.productLimits.dailyOutreachSends - 1);
  });

  it("a send yesterday does not count against today's limit", async () => {
    const built = build({ caps: { dailySendLimit: 1 }, now: () => new Date("2026-01-02T00:30:00.000Z") });
    // Manually seed a 'sent' touch dated yesterday by sending under an earlier clock, then advance.
    const store = built.store;
    const yesterday = await store.create(
      { workspaceId: WID, prospectRef: "old", prospect: { ref: "old", name: "Old" }, kind: "connection", body: "x" },
      new Date("2026-01-01T10:00:00.000Z"),
    );
    await store.applyOutcome(WID, yesterday.id, {
      status: "sent",
      approvalRequestId: APPROVAL,
      externalId: "y",
      error: null,
      updatedAt: new Date("2026-01-01T10:00:00.000Z"),
    });
    // Today's budget is intact.
    expect(await built.service.remainingToday(WID)).toBe(1);
    const today = await draftOne(built);
    const out = await built.service.send(WID, today.id, { approvalRequestId: APPROVAL });
    expect(out.status).toBe("sent");
  });

  it("no-credentials real adapter is a no-op recorded as failed (no external id)", async () => {
    const built = build({ provider: createRealProvider() });
    const touch = await draftOne(built);
    const out = await built.service.send(WID, touch.id, { approvalRequestId: APPROVAL });
    expect(out.status).toBe("failed");
    expect(out.externalId).toBeNull();
    expect(out.error).toBe("no credentials");
  });

  it("error fallback: a throwing provider becomes a recorded failed outcome", async () => {
    const built = build({
      provider: new SpyProvider(() => {
        throw new Error("boom");
      }),
    });
    const touch = await draftOne(built);
    const out = await built.service.send(WID, touch.id, { approvalRequestId: APPROVAL });
    expect(out.status).toBe("failed");
    expect(out.externalId).toBeNull();
    expect(out.error).toBe("boom");
  });

  it("a provider failure result is recorded as failed with the error", async () => {
    const built = build({
      provider: new SpyProvider({ status: "failed", externalId: null, error: "rejected" }),
    });
    const touch = await draftOne(built);
    const out = await built.service.send(WID, touch.id, { approvalRequestId: APPROVAL });
    expect(out.status).toBe("failed");
    expect(out.error).toBe("rejected");
  });

  it("send is single-use: a second send on a terminal touch throws", async () => {
    const touch = await draftOne(b);
    await b.service.send(WID, touch.id, { approvalRequestId: APPROVAL });
    await expect(b.service.send(WID, touch.id, { approvalRequestId: APPROVAL })).rejects.toThrow(
      /already sent/,
    );
  });

  it("enforces workspace (IDOR) scoping on get/send", async () => {
    const touch = await draftOne(b);
    expect(await b.service.get(OTHER_WID, touch.id)).toBeNull();
    await expect(
      b.service.send(OTHER_WID, touch.id, { approvalRequestId: APPROVAL }),
    ).rejects.toThrow(/no such outreach touch/);
  });

  it("lists a workspace's touches newest first, filterable by status", async () => {
    const first = await draftOne(b, { prospect: { ...PROSPECT, ref: "a" } });
    await draftOne(b, { prospect: { ...PROSPECT, ref: "b" } });
    await b.service.send(WID, first.id, { approvalRequestId: APPROVAL });
    expect(await b.service.list(WID)).toHaveLength(2);
    const drafted = await b.service.list(WID, "drafted");
    expect(drafted.map((t) => t.prospectRef)).toEqual(["b"]);
    const sent = await b.service.list(WID, "sent");
    expect(sent.map((t) => t.prospectRef)).toEqual(["a"]);
  });

  it("exposes resolved caps via policy", () => {
    const built = build({ caps: { dailySendLimit: 7 } });
    expect(built.service.policy.dailySendLimit).toBe(7);
    expect(built.service.policy.enabled).toBe(true);
  });
});
