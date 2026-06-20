import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadSkillsManifest, agentsDir } from "../../src/evals/loader.js";

/**
 * Guard for the marketing fleet's reference expertise (#19): every reference id the skills manifest
 * promises an agent (e.g. `seo/serp-intent-map`) MUST resolve to a real, substantive file under
 * `platform/agents/skills/references/`. Before this, the manifest pointed every agent at deep
 * per-discipline expertise that was never written — the agents routed to nothing. This test makes the
 * promise enforceable: a reference can never again be listed without the world-class content behind it.
 */
describe("marketing skill references — every promised expertise file exists and is substantive", () => {
  const manifest = loadSkillsManifest();
  const refRoot = join(agentsDir(), "skills", "references");

  const allRefs: Array<{ agent: string; ref: string }> = [];
  for (const [agent, spec] of Object.entries(manifest.agents)) {
    for (const ref of spec.references ?? []) allRefs.push({ agent, ref });
  }

  it("the manifest actually lists references for the marketing agents", () => {
    expect(allRefs.length).toBeGreaterThanOrEqual(20);
  });

  it.each(allRefs)("$agent → $ref resolves to a real, substantive reference file", ({ ref }) => {
    const path = join(refRoot, `${ref}.md`);
    expect(existsSync(path), `missing reference file: references/${ref}.md`).toBe(true);
    const text = readFileSync(path, "utf8");
    // Real expertise, not a stub: substantive word count + valid frontmatter + the house sign-off.
    expect(text.split(/\s+/).filter(Boolean).length).toBeGreaterThan(300);
    expect(text.startsWith("---")).toBe(true);
    expect(text).toContain("kind: reference");
    expect(text.toLowerCase()).toContain("made by robots, steered by humans");
  });
});
