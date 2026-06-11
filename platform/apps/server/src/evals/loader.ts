/**
 * Fleet skill + eval-suite loader (#155). The single IO seam that reads the versioned files under
 * `platform/agents/{skills,evals}` — skill content (for the runbook-invariant checks) and the offline eval
 * suites + baseline. Kept apart from the pure `corpus.ts`/`grade.ts` so the loading (disk) is testable in
 * isolation and the judging stays pure. Mirrors `db/migrate.ts`'s `import.meta.url` path resolution.
 *
 * `FLEET_AGENTS_DIR` overrides the directory (tests point it at a fixture); otherwise it resolves relative
 * to this module: `apps/server/src/evals` → `platform/agents`.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSuite } from "./corpus.js";
import type { EvalSuite } from "./types.js";
import type { EvalBaselineEntry } from "./regression.js";

/** The resolved `platform/agents` directory (env override wins). */
export function agentsDir(): string {
  const override = process.env.FLEET_AGENTS_DIR;
  if (override) return override;
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../../agents");
}

/** Concatenated knowledge + runbook text for one agent (lowercased downstream by the invariant checks). */
export function loadSkillText(agent: string, dir = agentsDir()): string {
  const base = join(dir, "skills", agent);
  const parts: string[] = [];
  for (const file of ["knowledge.md", "runbook.md"]) {
    const p = join(base, file);
    if (existsSync(p)) parts.push(readFileSync(p, "utf8"));
  }
  return parts.join("\n\n");
}

/** Load + validate one agent's eval suite. Throws (with the agent named) on a malformed suite. */
export function loadSuite(agent: string, dir = agentsDir()): EvalSuite {
  const p = join(dir, "evals", `${agent}.json`);
  try {
    return parseSuite(JSON.parse(readFileSync(p, "utf8")));
  } catch (err) {
    throw new Error(`failed to load eval suite for ${agent}: ${(err as Error).message}`);
  }
}

/** The agents that have an eval suite on disk (the `<agent>.json` files, excluding `baseline.json`). */
export function listSuiteAgents(dir = agentsDir()): string[] {
  const evalsDir = join(dir, "evals");
  if (!existsSync(evalsDir)) return [];
  return readdirSync(evalsDir)
    .filter((f) => f.endsWith(".json") && f !== "baseline.json")
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

/** The committed baseline pass-rates (the before side of the CI delta). */
export interface EvalBaseline {
  tolerance: number;
  agents: Record<string, EvalBaselineEntry & { total?: number }>;
}

export function loadBaseline(dir = agentsDir()): EvalBaseline {
  const p = join(dir, "evals", "baseline.json");
  if (!existsSync(p)) return { tolerance: 0, agents: {} };
  return JSON.parse(readFileSync(p, "utf8")) as EvalBaseline;
}

/** The skills manifest (catalog of per-agent skill ids + versions). */
export interface SkillsManifest {
  version: string;
  agents: Record<
    string,
    {
      skills: { id: string; kind: string; path: string; version: string }[];
      references: string[];
      metrics: string[];
    }
  >;
}

export function loadSkillsManifest(dir = agentsDir()): SkillsManifest {
  const p = join(dir, "skills", "manifest.json");
  return JSON.parse(readFileSync(p, "utf8")) as SkillsManifest;
}
