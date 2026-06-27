/**
 * Pure data-layer tests for the everyday shell (#784): the greeting bucket, compact number formatting, the
 * signed delta, and the shape/invariants of the seed dataset (a finished deliverable on every approval, a
 * timestamp on every external action — the surface contract the shell renders).
 */
import { describe, expect, it } from "vitest";
import { compactCount, defaultAgentRoom, defaultConnectors, partOfDay, seedEveryday, signedDelta } from "./everyday-data.js";

describe("partOfDay (#784)", () => {
  it("buckets the local hour into morning / afternoon / evening", () => {
    expect(partOfDay(0)).toBe("morning");
    expect(partOfDay(8)).toBe("morning");
    expect(partOfDay(11)).toBe("morning");
    expect(partOfDay(12)).toBe("afternoon");
    expect(partOfDay(17)).toBe("afternoon");
    expect(partOfDay(18)).toBe("evening");
    expect(partOfDay(23)).toBe("evening");
  });

  it("wraps out-of-range hours instead of throwing", () => {
    expect(partOfDay(24)).toBe("morning");
    expect(partOfDay(-1)).toBe("evening");
  });
});

describe("compactCount (#784)", () => {
  it("leaves sub-thousands alone", () => {
    expect(compactCount(0)).toBe("0");
    expect(compactCount(14)).toBe("14");
    expect(compactCount(999)).toBe("999");
  });

  it("compacts thousands, dropping a trailing .0", () => {
    expect(compactCount(1000)).toBe("1k");
    expect(compactCount(1200)).toBe("1.2k");
    expect(compactCount(12000)).toBe("12k");
  });

  it("never crashes on non-finite input", () => {
    expect(compactCount(Number.NaN)).toBe("0");
  });
});

describe("signedDelta (#784)", () => {
  it("signs a non-zero delta and dashes a flat one", () => {
    expect(signedDelta(3)).toBe("+3");
    expect(signedDelta(-2)).toBe("-2");
    expect(signedDelta(0)).toBe("—");
  });
});

describe("seedEveryday (#784) — the surface contract", () => {
  it("names the signed-in member and defaults sensibly", () => {
    expect(seedEveryday("Gagan").memberName).toBe("Gagan");
    expect(seedEveryday().memberName).toBeTruthy();
  });

  it("puts a real, finished deliverable on every approval card — never bare chatter", () => {
    for (const card of seedEveryday().approvals) {
      expect(card.deliverable.title).toBeTruthy();
      expect(card.deliverable.preview.length).toBeGreaterThan(10);
      expect(card.consequence).toBeTruthy();
      expect(card.approvalRequestId).toMatch(/^apr_/);
    }
  });

  it("gates the spend card on money and leaves the inbox reply free", () => {
    const spend = seedEveryday().approvals.find((c) => c.costsMoney);
    const free = seedEveryday().approvals.find((c) => !c.costsMoney);
    expect(spend?.amount).toBeTruthy();
    expect(free).toBeDefined();
  });

  it("timestamps every external action in the transparency log", () => {
    for (const act of seedEveryday().transparency) {
      expect(act.at).toBeTruthy();
      expect(act.action).toBeTruthy();
    }
  });

  it("requires a clickable receipt for every completed external action (#625)", () => {
    for (const act of seedEveryday().transparency) {
      expect(act.href).toMatch(/^https:\/\//);
    }
  });

  it("includes receipt examples for published artifacts, sent emails, and signups (#625)", () => {
    const actions = seedEveryday().transparency;
    expect(actions.some((act) => act.receiptLabel === "open live page")).toBe(true);
    expect(actions.some((act) => act.receiptLabel === "open sent email")).toBe(true);
    expect(actions.some((act) => act.receiptLabel === "open signup")).toBe(true);
  });
});

describe("defaultAgentRoom (#1265)", () => {
  it("starts a multi-agent room with an operator lane", () => {
    const room = defaultAgentRoom("ipop.ai");
    expect(room.map((lane) => lane.agent)).toEqual(["Scout", "Quill", "Echo", "Lens", "Operator"]);
    expect(room.find((lane) => lane.agent === "Operator")?.status).toBe("codex");
    expect(room[0]?.task).toContain("ipop.ai");
  });
});

describe("defaultConnectors (#1265)", () => {
  it("models the direct connect setup without pretending anything is connected", () => {
    const connectors = defaultConnectors();
    expect(connectors.map((connector) => connector.name)).toContain("Email");
    expect(connectors.map((connector) => connector.name)).toContain("Web room");
    expect(connectors.map((connector) => connector.name)).toContain("iMessage");
    expect(connectors.map((connector) => connector.name)).toContain("WhatsApp room");
    expect(connectors.map((connector) => connector.name)).toContain("Telegram room");
    expect(new Set(connectors.map((connector) => connector.group))).toEqual(
      new Set(["visibility", "productivity", "marketing", "publishing"]),
    );
    expect(connectors.every((connector) => connector.status !== "connected")).toBe(true);
    expect(connectors.every((connector) => connector.actionLabel.length > 0)).toBe(true);
  });
});
