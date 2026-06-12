import { getCheck } from "./catalog.js";
import { fingerprintFinding } from "./fingerprint.js";
import type { QaCheck, QaFinding, RawCheckResult } from "./types.js";

/**
 * The pure QA classifier (#171, ADR-0171). A failed raw check result + its catalog entry → a structured
 * {@link QaFinding} (surface, severity, repro steps, expected vs actual, evidence, dedup signature).
 * **Pure + deterministic**: same input → same findings (signatures included). Passing checks are not
 * bugs; results for unknown check ids are dropped (never an invented finding).
 *
 * `catalog` is injectable so a suite-scoped subset can be classified in isolation; it defaults to a
 * lookup over the full catalog.
 */
export function classifyResults(results: RawCheckResult[], catalog?: QaCheck[]): QaFinding[] {
  const lookup = catalog ? new Map(catalog.map((c) => [c.id, c])) : null;
  const resolve = (id: string): QaCheck | undefined => (lookup ? lookup.get(id) : getCheck(id));

  const findings: QaFinding[] = [];
  for (const result of results) {
    if (result.ok) continue; // a passing check is not a bug
    const check = resolve(result.checkId);
    if (!check) continue; // unknown id — drop, never guess
    findings.push({
      checkId: check.id,
      surface: check.surface,
      severity: check.severityOnFail,
      title: check.title,
      steps: check.steps,
      expected: check.expectation,
      actual: result.actual ?? "(no detail captured)",
      evidencePath: result.evidencePath,
      signature: fingerprintFinding({ surface: check.surface, checkId: check.id, actual: result.actual }),
    });
  }
  return findings;
}
