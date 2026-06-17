import { describe, it, expect } from "vitest";
import {
  normalizeObjective,
  resolveDedupeEnabled,
  findDuplicateOpenTask,
  collapseDuplicateDeliverables,
  DELIVERABLE_ACTION,
  type DedupeOpenTask,
} from "../../../src/marketing/dedup.js";

/**
 * #322 idempotent task / draft dedup. Pure decisions only — no DB, no clock. Pins: the objective
 * normaliser (so trivially-different phrasings of the SAME audit collapse, but genuinely different goals
 * do not); the owner-workspace-first default-OFF rollout gate; the open-task duplicate finder used at the
 * launch seam to skip a re-brief; and the spend-approval draft collapse that shows one card, not twelve.
 */

describe("#322 normalizeObjective", () => {
  it("lowercases, trims, and collapses internal whitespace", () => {
    expect(normalizeObjective("  Audit   our   HOMEPAGE  ")).toBe("audit our homepage");
  });

  it("strips a leading @handle mention prefix (the structural brief lead-in)", () => {
    expect(normalizeObjective("@scout Audit our website homepage for SEO")).toBe(
      "audit our website homepage for seo",
    );
    expect(normalizeObjective("@Scout   @echo  rank us")).toBe("rank us");
  });

  it("strips trailing punctuation and quote/period noise so phrasings collapse", () => {
    expect(normalizeObjective("Audit our homepage for SEO.")).toBe("audit our homepage for seo");
    expect(normalizeObjective('“Audit our homepage for SEO”')).toBe("audit our homepage for seo");
  });

  it("treats different objectives as distinct", () => {
    expect(normalizeObjective("Audit our homepage for SEO")).not.toBe(
      normalizeObjective("Write a launch tweet"),
    );
  });

  it("never throws on empty / whitespace input (returns empty string)", () => {
    expect(normalizeObjective("")).toBe("");
    expect(normalizeObjective("   ")).toBe("");
    expect(normalizeObjective("@scout")).toBe("");
  });
});

describe("#322 resolveDedupeEnabled — default OFF, owner-workspace-first", () => {
  it("is OFF when no config is supplied", () => {
    expect(resolveDedupeEnabled(undefined, "ws-1")).toBe(false);
  });

  it("is OFF when the master flag is not explicitly true", () => {
    expect(resolveDedupeEnabled({ dedupeTasks: false, ownerWorkspaceId: "ws-1" }, "ws-1")).toBe(false);
    expect(resolveDedupeEnabled({ ownerWorkspaceId: "ws-1" }, "ws-1")).toBe(false);
  });

  it("enabled + owner-only (default): ONLY the named owner workspace is in scope", () => {
    const cfg = { dedupeTasks: true, ownerWorkspaceId: "ws-owner" };
    expect(resolveDedupeEnabled(cfg, "ws-owner")).toBe(true);
    expect(resolveDedupeEnabled(cfg, "ws-other")).toBe(false);
  });

  it("enabled without naming an owner workspace is in scope for NOBODY (safest default)", () => {
    expect(resolveDedupeEnabled({ dedupeTasks: true }, "ws-1")).toBe(false);
  });

  it("dedupeOwnerWorkspaceOnly:false broadens to every tenant once enabled", () => {
    const cfg = { dedupeTasks: true, dedupeOwnerWorkspaceOnly: false };
    expect(resolveDedupeEnabled(cfg, "ws-1")).toBe(true);
    expect(resolveDedupeEnabled(cfg, "ws-2")).toBe(true);
  });
});

describe("#322 findDuplicateOpenTask", () => {
  const open: DedupeOpenTask[] = [
    { id: "mt-1", department: "seo", task: "Audit our website's homepage for SEO and summarise quick wins" },
    { id: "mt-2", department: "content", task: "Draft the launch blog post" },
  ];

  it("returns the existing open task when the same objective is re-briefed to the same department", () => {
    const dup = findDuplicateOpenTask({
      department: "seo",
      objective: "@scout  audit our website's HOMEPAGE for SEO and summarise quick wins.",
      openTasks: open,
    });
    expect(dup?.id).toBe("mt-1");
  });

  it("does NOT match across departments (same words, different department = not a duplicate)", () => {
    const dup = findDuplicateOpenTask({
      department: "content",
      objective: "Audit our website's homepage for SEO and summarise quick wins",
      openTasks: open,
    });
    expect(dup).toBeNull();
  });

  it("does NOT match a genuinely different objective in the same department", () => {
    const dup = findDuplicateOpenTask({
      department: "seo",
      objective: "Build us a backlink outreach plan",
      openTasks: open,
    });
    expect(dup).toBeNull();
  });

  it("returns null on an empty objective (never collapses nothing)", () => {
    expect(findDuplicateOpenTask({ department: "seo", objective: "   ", openTasks: open })).toBeNull();
  });
});

describe("#322 collapseDuplicateDeliverables — one card, not twelve", () => {
  function deliverable(id: string, requester: string, task: string): {
    id: string;
    requesterMemberId: string;
    actionType: string;
    payload: Record<string, unknown>;
  } {
    return { id, requesterMemberId: requester, actionType: DELIVERABLE_ACTION, payload: { task } };
  }

  it("keeps the FIRST of several identical-objective deliverable drafts from the same agent", () => {
    const items = [
      deliverable("a", "am-scout", "Audit our homepage for SEO"),
      deliverable("b", "am-scout", "Audit our homepage for SEO."),
      deliverable("c", "am-scout", "@scout audit our HOMEPAGE for seo"),
    ];
    const out = collapseDuplicateDeliverables(items);
    expect(out.map((i) => i.id)).toEqual(["a"]);
  });

  it("keeps duplicates from DIFFERENT agents (a different department is not a dup)", () => {
    const items = [
      deliverable("a", "am-scout", "Audit our homepage for SEO"),
      deliverable("b", "am-quill", "Audit our homepage for SEO"),
    ];
    expect(collapseDuplicateDeliverables(items).map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("never collapses non-deliverable approvals (money / other action types pass through)", () => {
    const items = [
      { id: "x", requesterMemberId: "am-scout", actionType: "external.send", payload: { task: "send" } },
      { id: "y", requesterMemberId: "am-scout", actionType: "external.send", payload: { task: "send" } },
    ];
    expect(collapseDuplicateDeliverables(items).map((i) => i.id)).toEqual(["x", "y"]);
  });

  it("preserves order and is a no-op when there are no duplicates", () => {
    const items = [
      deliverable("a", "am-scout", "Audit our homepage for SEO"),
      deliverable("b", "am-scout", "Write the launch tweet"),
    ];
    expect(collapseDuplicateDeliverables(items).map((i) => i.id)).toEqual(["a", "b"]);
  });
});
