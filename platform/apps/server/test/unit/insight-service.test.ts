import { describe, it, expect, beforeEach } from "vitest";
import {
  InsightMiner,
  InsightNotFoundError,
  type InsightRepo,
  type KilledAngleStore,
  type Miner,
  type UsageMeter,
  type VentureIdeaCreator,
} from "../../src/insight/service.js";
import { insightDedupeKey } from "../../src/insight/dedupe.js";
import { INSIGHT_DEFAULTS, type InsightCaps } from "../../src/insight/caps.js";
import type { EvidenceRef, Insight, InsightInput, InsightSource, SourceInput } from "../../src/insight/types.js";

const NOW = new Date("2026-06-11T00:00:00Z");

/** A tiny in-memory repo fake — tenant-scoped by construction (every row carries workspaceId). */
function makeRepo() {
  const sources: InsightSource[] = [];
  const rows: Insight[] = [];
  const evidence: { workspaceId: string; insightId: string; ref: EvidenceRef }[] = [];
  let seq = 0;
  const repo: InsightRepo = {
    createSource: async (input) => {
      const s: InsightSource = {
        id: `src-${++seq}`,
        createdAt: NOW,
        status: "candidate",
        ...input,
      };
      sources.push(s);
      return s;
    },
    listSources: async (wid) =>
      sources.filter((s) => s.workspaceId === wid).sort((a, b) => b.evidenceStrength - a.evidenceStrength),
    listCandidateSources: async (wid) =>
      sources
        .filter((s) => s.workspaceId === wid && s.status === "candidate")
        .sort((a, b) => b.evidenceStrength - a.evidenceStrength),
    setSourceStatus: async (wid, id, status) => {
      const s = sources.find((x) => x.id === id && x.workspaceId === wid);
      if (s) s.status = status;
    },
    createInsight: async (input) => {
      const row: Insight = {
        id: `ins-${++seq}`,
        status: "mined",
        promotedIdeaId: null,
        createdAt: NOW,
        ...input,
      };
      rows.push(row);
      return row;
    },
    insertEvidence: async (workspaceId, insightId, refs) => {
      for (const ref of refs) evidence.push({ workspaceId, insightId, ref });
    },
    listEvidence: async (wid, insightId) =>
      evidence.filter((e) => e.workspaceId === wid && e.insightId === insightId).map((e) => e.ref),
    getInsight: async (wid, id) => rows.find((r) => r.id === id && r.workspaceId === wid),
    listInsights: async (wid) => rows.filter((r) => r.workspaceId === wid),
    setInsightStatus: async (wid, id, status) => {
      const r = rows.find((x) => x.id === id && x.workspaceId === wid);
      if (r) r.status = status;
    },
    setInsightPromotion: async (wid, id, ideaId) => {
      const r = rows.find((x) => x.id === id && x.workspaceId === wid);
      if (r) {
        r.promotedIdeaId = ideaId;
        r.status = "promoted";
      }
    },
  };
  return { repo, sources, rows, evidence };
}

let caps: InsightCaps;
let killSwitch = false;
let spent = 0;
let budget = 0;
let charged: number[] = [];
const killedKeys: string[] = [];
const recordedKills: { dedupeKey: string }[] = [];
let submittedIdeas: { workspaceId: string; insight: string }[] = [];

const usage: UsageMeter = {
  spentCents: async () => spent,
  charge: async (_w, c) => {
    charged.push(c);
    spent += c;
  },
};
const killedAngles: KilledAngleStore = {
  listKilledKeys: async () => killedKeys,
  recordKill: async (input) => {
    recordedKills.push({ dedupeKey: input.dedupeKey });
    killedKeys.push(input.dedupeKey);
  },
};
const ventures: VentureIdeaCreator = {
  submit: async (workspaceId, input) => {
    submittedIdeas.push({ workspaceId, insight: input.insight });
    return { id: `idea-${submittedIdeas.length}` };
  },
};

/** A miner that emits one insight per source, echoing source kind into the statement. */
function minerFrom(make: (s: InsightSource) => InsightInput[]): Miner {
  return { mine: async (s) => make(s) };
}

function build(repo: InsightRepo, miner: Miner) {
  return new InsightMiner({
    repo,
    miner,
    ventures,
    killedAngles,
    caps: () => caps,
    usage,
    scaleBudgetCents: () => budget,
    killSwitch: async () => killSwitch,
    now: () => NOW,
  });
}

const SOURCE: SourceInput = {
  kind: "support_forum",
  url: "https://forum.example/t/42",
  title: "Flaky cache rage thread",
  observedAt: NOW,
};

function painInsight(over: Partial<InsightInput> = {}): InsightInput {
  return {
    kind: "pain",
    statement: "CI caches corrupt silently and devs lose hours",
    painIntensity: 9,
    competitionAbsence: 8,
    freshnessAt: NOW,
    evidence: [{ sourceUrl: "https://forum.example/t/42", excerpt: "happens weekly", observedAt: NOW, sourceId: null }],
    sourceId: null,
    ...over,
  };
}

beforeEach(() => {
  caps = { ...INSIGHT_DEFAULTS, enabled: true };
  killSwitch = false;
  spent = 0;
  budget = 0;
  charged = [];
  killedKeys.length = 0;
  recordedKills.length = 0;
  submittedIdeas = [];
});

describe("InsightMiner.addSource (list is the strategy)", () => {
  it("stamps a pure evidence-strength rank and persists the candidate", async () => {
    const { repo, sources } = makeRepo();
    const miner = build(repo, minerFrom(() => []));
    const s = await miner.addSource("w1", SOURCE, "m1");
    expect(s.evidenceStrength).toBeGreaterThan(0);
    expect(sources[0].workspaceId).toBe("w1"); // tenant-scoped
  });
});

describe("InsightMiner.captureOwnerSecret (ungated, first-class)", () => {
  it("persists an owner_secret insight with no kill-switch/budget gate and no charge", async () => {
    const { repo, rows } = makeRepo();
    killSwitch = true; // even with the kill switch engaged, owner intake is ungated
    const miner = build(repo, minerFrom(() => []));
    const ins = await miner.captureOwnerSecret(
      "w1",
      { statement: "Enterprises secretly run two CRMs", painIntensity: 8, competitionAbsence: 9 },
      "owner",
    );
    expect(ins.kind).toBe("owner_secret");
    expect(rows[0].workspaceId).toBe("w1");
    expect(charged).toEqual([]); // never charged
  });
});

describe("InsightMiner.mine (kill-switch + budget gated)", () => {
  it("skips with 'disabled' when the miner flag is off (default-OFF)", async () => {
    const { repo } = makeRepo();
    caps = { ...INSIGHT_DEFAULTS, enabled: false };
    const miner = build(repo, minerFrom(() => [painInsight()]));
    const r = await miner.mine("w1");
    expect(r.skipped).toBe("disabled");
    expect(r.chargedCents).toBe(0);
  });

  it("skips with 'kill_switch' when the #17 kill switch is engaged (no charge)", async () => {
    const { repo } = makeRepo();
    killSwitch = true;
    const miner = build(repo, minerFrom(() => [painInsight()]));
    const r = await miner.mine("w1");
    expect(r.skipped).toBe("kill_switch");
    expect(charged).toEqual([]);
  });

  it("skips with 'budget' when the #71 tenant budget is already exhausted (no charge)", async () => {
    const { repo } = makeRepo();
    budget = 100;
    spent = 100; // at/over budget
    const miner = build(repo, minerFrom(() => [painInsight()]));
    const r = await miner.mine("w1");
    expect(r.skipped).toBe("budget");
    expect(charged).toEqual([]);
  });

  it("charges one pass and produces ranked insights from candidate sources when allowed", async () => {
    const { repo, rows } = makeRepo();
    const miner = build(repo, minerFrom(() => [painInsight()]));
    await miner.addSource("w1", SOURCE, "m1");
    const r = await miner.mine("w1", "m1");
    expect(r.skipped).toBeNull();
    expect(r.chargedCents).toBe(caps.mineCostCents);
    expect(r.insights).toHaveLength(1);
    expect(rows[0].score).toBeGreaterThan(0);
  });

  it("only mines sources at/above minSourceStrength (the list cut)", async () => {
    const { repo } = makeRepo();
    caps = { ...INSIGHT_DEFAULTS, enabled: true, minSourceStrength: 99 };
    const miner = build(repo, minerFrom(() => [painInsight()]));
    await miner.addSource("w1", { ...SOURCE, kind: "pricing" }, "m1"); // weak source
    const r = await miner.mine("w1");
    expect(r.insights).toHaveLength(0);
  });

  it("suppresses a candidate that repeats a KILLed angle uncited (never persisted)", async () => {
    const { repo, rows } = makeRepo();
    const statement = "rebuild the thing nobody asked for";
    killedKeys.push(insightDedupeKey(statement));
    const miner = build(repo, minerFrom(() => [painInsight({ statement, evidence: [] })]));
    await miner.addSource("w1", SOURCE, "m1");
    const r = await miner.mine("w1");
    expect(r.suppressed).toBe(1);
    expect(r.insights).toHaveLength(0);
    expect(rows).toHaveLength(0);
  });

  it("does NOT suppress a killed angle that now carries a real citation", async () => {
    const { repo } = makeRepo();
    const statement = "rebuild the thing nobody asked for";
    killedKeys.push(insightDedupeKey(statement));
    const cited = painInsight({
      statement,
      evidence: [{ sourceUrl: "https://news.example/new", excerpt: "regulation changed", observedAt: NOW, sourceId: null }],
    });
    const miner = build(repo, minerFrom(() => [cited]));
    await miner.addSource("w1", SOURCE, "m1");
    const r = await miner.mine("w1");
    expect(r.suppressed).toBe(0);
    expect(r.insights).toHaveLength(1);
  });

  it("caps insights at maxInsightsPerMine", async () => {
    const { repo } = makeRepo();
    caps = { ...INSIGHT_DEFAULTS, enabled: true, maxInsightsPerMine: 1 };
    const miner = build(repo, minerFrom((s) => [painInsight({ statement: `a ${s.id}` }), painInsight({ statement: `b ${s.id}` })]));
    await miner.addSource("w1", SOURCE, "m1");
    const r = await miner.mine("w1");
    expect(r.insights).toHaveLength(1);
  });
});

describe("InsightMiner.promote (insight → venture idea with provenance)", () => {
  it("submits a venture idea carrying the insight as the secret + links it back", async () => {
    const { repo, rows } = makeRepo();
    const miner = build(repo, minerFrom(() => []));
    const ins = await miner.captureOwnerSecret(
      "w1",
      { statement: "Hospitals reuse fax for HIPAA cover", painIntensity: 8, competitionAbsence: 9 },
      "owner",
    );
    const r = await miner.promote("w1", ins.id, { targetUser: "ops leads", wedge: "one clinic", marketPath: "$2B" }, "owner");
    expect(r.suppressed).toBe(false);
    expect(r.ideaId).toBe("idea-1");
    expect(submittedIdeas[0]).toMatchObject({ workspaceId: "w1", insight: ins.statement });
    expect(rows[0].promotedIdeaId).toBe("idea-1");
    expect(rows[0].status).toBe("promoted");
  });

  it("suppresses (does not promote) a killed-uncited angle and marks it duplicate", async () => {
    const { repo, rows } = makeRepo();
    const miner = build(repo, minerFrom(() => []));
    const ins = await miner.captureOwnerSecret(
      "w1",
      { statement: "a previously killed angle", painIntensity: 5, competitionAbsence: 5 },
      "owner",
    );
    killedKeys.push(insightDedupeKey(ins.statement)); // it gets killed
    const r = await miner.promote("w1", ins.id, { targetUser: "x", wedge: "y", marketPath: "z" }, "owner");
    expect(r.suppressed).toBe(true);
    expect(r.ideaId).toBeNull();
    expect(submittedIdeas).toHaveLength(0);
    expect(rows[0].status).toBe("duplicate");
  });

  it("throws InsightNotFoundError for a missing/cross-tenant insight", async () => {
    const { repo } = makeRepo();
    const miner = build(repo, minerFrom(() => []));
    const ins = await miner.captureOwnerSecret("w1", { statement: "s", painIntensity: 5, competitionAbsence: 5 }, "owner");
    await expect(
      miner.promote("w2", ins.id, { targetUser: "x", wedge: "y", marketPath: "z" }, "owner"),
    ).rejects.toBeInstanceOf(InsightNotFoundError);
  });
});

describe("InsightMiner.kill (records the angle to memory so it never returns uncited)", () => {
  it("marks the insight killed and records its dedupe key", async () => {
    const { repo, rows } = makeRepo();
    const miner = build(repo, minerFrom(() => []));
    const ins = await miner.captureOwnerSecret("w1", { statement: "kill me", painIntensity: 5, competitionAbsence: 5 }, "owner");
    await miner.kill("w1", ins.id, "not fundable", "owner");
    expect(rows[0].status).toBe("killed");
    expect(recordedKills[0].dedupeKey).toBe(insightDedupeKey("kill me"));
  });
});
