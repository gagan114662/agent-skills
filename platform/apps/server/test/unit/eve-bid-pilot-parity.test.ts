import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { departmentForHandle } from "../../src/marketing/blueprint.js";

/**
 * #339 eve pilot — behavior-parity gate.
 *
 * The pilot at `platform/pilots/eve-bid/` scaffolds the @bid agent on Vercel's eve framework. It is
 * build/typecheck/lint-isolated (outside the pnpm workspace), so nothing else compiles it — this test
 * is the contract that proves the port preserves @bid's behavior against the LIVE bespoke source of
 * truth (`marketing/blueprint.ts` + `agents/skills/bid/*`). It reads both scaffolds as text (no eve
 * import, so no dependency on the pilot's uninstalled `eve`/`zod`) and asserts the invariants that
 * matter — the draft-then-gate / never-spend rule (#200 §4), governed-source discipline, the
 * tool-ceiling, the managed-model rule, and identity — survive the translation.
 */

const pilot = (p: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../pilots/eve-bid/${p}`, import.meta.url)), "utf8");
const bespoke = (p: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../agents/skills/bid/${p}`, import.meta.url)), "utf8");

const instructions = pilot("agent/instructions.md");
const agentTs = pilot("agent/agent.ts");
const eveKnowledge = pilot("agent/skills/knowledge.md");
const eveRunbook = pilot("agent/skills/runbook.md");
const bidKnowledge = bespoke("knowledge.md");
const bidRunbook = bespoke("runbook.md");

const toolsDir = fileURLToPath(new URL("../../../../pilots/eve-bid/agent/tools/", import.meta.url));
const toolFiles = readdirSync(toolsDir).filter((f) => f.endsWith(".ts"));
const toolSrc = (f: string) => readFileSync(`${toolsDir}${f}`, "utf8");

const MONEY_OR_SEND = /spend|send|post|publish|charge|refund|pay|tweet/i;

describe("#339 eve-bid pilot ⇄ bespoke @bid parity", () => {
  it("identity + domain match the bespoke @bid (ads / paid acquisition / CAC)", () => {
    expect(departmentForHandle("bid")?.channel).toBe("ads"); // the live source of truth still has @bid
    const charter = instructions.toLowerCase();
    expect(charter).toContain("@bid");
    expect(charter).toContain("ads");
    expect(charter).toMatch(/paid acquisition/);
    expect(charter).toMatch(/cac/);
  });

  it("the charter carries @bid's draft-then-gate, never-spend invariant (#200 §4)", () => {
    // The bespoke invariant lives in the generated system prompt — assert the same clauses in the
    // eve charter so leaving the building still requires a human, never an autonomous tool.
    const bespokePrompt = departmentForHandle("bid")?.agent.systemPrompt ?? "";
    expect(bespokePrompt.toLowerCase()).toContain("approve"); // sanity: bespoke really is gated
    const c = instructions.toLowerCase();
    expect(c).toContain("draft");
    expect(c).toContain("stop");
    expect(c).toMatch(/wait for a human to approve/);
    expect(c).toMatch(/never claim something\s+was sent, posted, or spent/);
    expect(c).toMatch(/no autonomous path to spend/);
  });

  it("every money/send tool is human-gated before it runs (eve-native #13 gate)", () => {
    const gated = toolFiles.filter((f) => MONEY_OR_SEND.test(f));
    expect(gated.length).toBeGreaterThan(0); // there IS a spend tool, and it must be gated
    for (const f of gated) {
      const src = toolSrc(f);
      // pre-execution human gate (#200 §4) — not post-hoc review
      expect(src).toMatch(/needsApproval/);
      expect(src).toMatch(/always\(\)/);
    }
  });

  it("the draft tool drafts only — it proposes spend but never spends", () => {
    const draft = toolSrc("propose_ads_plan.ts");
    expect(draft).not.toMatch(/needsApproval/); // drafting is free + reversible, no gate needed
    expect(draft).toMatch(/spent: false/);
    expect(draft).toMatch(/"draft"/);
  });

  it("the spend tool is a dry pilot stub — no live provider connection", () => {
    const spend = toolSrc("record_ad_spend.ts");
    expect(spend).toMatch(/spent: false/);
    expect(spend).toMatch(/no live ad account/i);
  });

  it("governed-source discipline ports over from the bespoke skills", () => {
    // The same provenance ladder + one-number rule the bespoke @bid runbook teaches.
    for (const phrase of ["semantic layer", "fallback", "provenance", "freshness"]) {
      expect(bidRunbook.toLowerCase()).toContain(phrase); // sanity: bespoke teaches it
      expect(eveRunbook.toLowerCase()).toContain(phrase); // and so does the port
    }
    expect(eveRunbook.toLowerCase()).toMatch(/one-number rule|same\s+number/);
    expect(eveRunbook.toLowerCase()).toMatch(/draft-then-gate/);
  });

  it("the knowledge router ports over (thin router, metrics via the semantic layer)", () => {
    expect(bidKnowledge.toLowerCase()).toContain("thin router");
    expect(eveKnowledge.toLowerCase()).toContain("thin router");
    expect(eveKnowledge.toLowerCase()).toContain("semantic layer");
    // the curated references the manifest declares are preserved
    for (const ref of ["budget-pacing", "channel-mix", "cac-targets"]) {
      expect(eveKnowledge).toContain(ref);
    }
  });

  it("uses the managed fleet model — a user never picks a model", () => {
    // Parity with the managed-model rule: bespoke @bid carries model:null → managed claude-opus-4-8;
    // the eve port pins that same managed model as an AI Gateway id (no picker, no regression).
    expect(departmentForHandle("bid")?.agent.model).toBeNull();
    expect(agentTs).toMatch(/claude-opus-4\.8/);
    expect(agentTs).not.toMatch(/model:\s*null/);
  });

  it("keeps the house voice", () => {
    for (const text of [instructions, eveKnowledge, eveRunbook]) {
      expect(text.toLowerCase()).toContain("made by robots, steered by humans");
    }
  });
});
