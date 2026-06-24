import { describe, it, expect } from "vitest";
import {
  resolveContentCadenceFlags,
  selectCadenceQuery,
  cadenceDayNumber,
  composeContentBrief,
  DEFAULT_CADENCE_LEAD,
} from "../../src/marketing/content-cadence/decide.js";

describe("resolveContentCadenceFlags (#416 default-OFF owner-first)", () => {
  const ws = "ws-owner";

  it("is disabled when config is undefined (prod with the block unset)", () => {
    expect(resolveContentCadenceFlags(undefined, ws)).toEqual({
      enabled: false,
      queries: [],
      lead: DEFAULT_CADENCE_LEAD,
    });
  });

  it("is disabled when enabled !== true", () => {
    expect(resolveContentCadenceFlags({ queries: ["a"] }, ws).enabled).toBe(false);
    expect(resolveContentCadenceFlags({ enabled: false, queries: ["a"] }, ws).enabled).toBe(false);
  });

  it("is disabled for a workspace outside the owner-first scope", () => {
    const cfg = { enabled: true, ownerWorkspaceId: "ws-owner", queries: ["a"] };
    expect(resolveContentCadenceFlags(cfg, "ws-other").enabled).toBe(false);
    expect(resolveContentCadenceFlags(cfg, "ws-owner").enabled).toBe(true);
  });

  it("allows all workspaces only when ownerWorkspaceOnly is explicitly false", () => {
    const cfg = { enabled: true, ownerWorkspaceOnly: false, queries: ["a"] };
    expect(resolveContentCadenceFlags(cfg, "any-ws").enabled).toBe(true);
  });

  it("trims, de-duplicates and drops blank queries (order preserved)", () => {
    const f = resolveContentCadenceFlags(
      {
        enabled: true,
        ownerWorkspaceOnly: false,
        queries: [" seo tool ", "seo tool", "", "  ", "ai agents"],
      },
      ws,
    );
    expect(f.queries).toEqual(["seo tool", "ai agents"]);
  });

  it("is disabled when the query calendar is effectively empty", () => {
    expect(
      resolveContentCadenceFlags(
        { enabled: true, ownerWorkspaceOnly: false, queries: ["", "  "] },
        ws,
      ).enabled,
    ).toBe(false);
  });

  it("normalizes the lead handle and defaults to the content lead", () => {
    expect(
      resolveContentCadenceFlags({ enabled: true, ownerWorkspaceOnly: false, queries: ["a"] }, ws)
        .lead,
    ).toBe("scout"); // #359: cadence starts with Scout (research), hands off to Quill
    expect(
      resolveContentCadenceFlags(
        { enabled: true, ownerWorkspaceOnly: false, queries: ["a"], lead: "@Scout" },
        ws,
      ).lead,
    ).toBe("scout");
  });
});

describe("selectCadenceQuery (round-robin so the calendar keeps moving)", () => {
  const qs = ["a", "b", "c"];
  it("rotates through the calendar by day", () => {
    expect(selectCadenceQuery(qs, 0)).toBe("a");
    expect(selectCadenceQuery(qs, 1)).toBe("b");
    expect(selectCadenceQuery(qs, 2)).toBe("c");
    expect(selectCadenceQuery(qs, 3)).toBe("a"); // wraps
  });
  it("returns null for an empty calendar", () => {
    expect(selectCadenceQuery([], 5)).toBeNull();
  });
  it("handles a negative day without going out of range", () => {
    expect(selectCadenceQuery(qs, -1)).toBe("c");
  });
});

describe("cadenceDayNumber", () => {
  it("buckets a timestamp into whole UTC days", () => {
    expect(cadenceDayNumber(new Date("2026-06-20T00:00:00Z"))).toBe(
      cadenceDayNumber(new Date("2026-06-20T23:59:59Z")),
    );
    expect(cadenceDayNumber(new Date("2026-06-21T00:00:00Z"))).toBe(
      cadenceDayNumber(new Date("2026-06-20T00:00:00Z")) + 1,
    );
  });
});

describe("composeContentBrief (#415 PRODUCE+PUBLISH, not audit)", () => {
  it("embeds the query and demands the COMPLETE post as the message (not a summary/audit)", () => {
    const brief = composeContentBrief("  best   seo  tool ");
    expect(brief).toContain('"best seo tool"'); // whitespace collapsed
    // The decisive fix (live PR #453): the agent's final MESSAGE ships verbatim — it must BE the post.
    expect(brief.toLowerCase()).toContain("complete post as your final message");
    expect(brief.toLowerCase()).toContain("not an outline or summary");
    expect(brief).toContain("SEO pre-publication validation");
    expect(brief.toLowerCase()).toContain("serp shape");
    expect(brief.toLowerCase()).toContain("estimated volume");
    // #359/#417: the brief is a Scout->Quill HANDOFF (the @quill line fires the handoff so the team coordinates).
    expect(brief).toContain("@scout:");
    expect(brief).toContain("@quill:");
    expect(brief.toLowerCase()).toContain("do not stage files");
  });

  it("surfaces a pre-validation verdict before the Scout→Quill writing handoff", () => {
    const brief = composeContentBrief("best seo tool", {
      query: "best seo tool",
      verdict: "needs_review",
      summary: "Existing rank receipt is below page one.",
      evidence: ["bestPosition=37", "volume=unavailable until a live provider is connected"],
    });

    expect(brief.indexOf("verdict: needs_review")).toBeLessThan(brief.indexOf("@scout:"));
    expect(brief).toContain("bestPosition=37");
    expect(brief.toLowerCase()).toContain("call out the risk clearly for the owner");
  });
});
