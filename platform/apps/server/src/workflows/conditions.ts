import type { ConditionOp, WorkflowCondition, WorkflowFacts } from "./types.js";

/**
 * The pure condition evaluator (#152, ADR-0152 §2). A workflow's conditions are an AND-list of
 * predicates over a facts bag (catalog rollups + metrics + trigger context). No IO, no clock — the
 * engine resolves the facts once, then calls this. Mirrors the #117/#147 pure-decision split so
 * firing logic is fully unit-testable.
 *
 * `resolveFact` walks a dot-path (`catalog.site.status`) so a workflow author references nested facts
 * without the engine flattening them. A missing path resolves to `undefined` (only `exists` treats that
 * specially; every comparison op is false against `undefined`).
 */

/** Walk a dot-path into the facts bag. Returns `undefined` for any missing segment. */
export function resolveFact(facts: WorkflowFacts, path: string): unknown {
  if (!path) return undefined;
  let cursor: unknown = facts;
  for (const segment of path.split(".")) {
    if (cursor === null || cursor === undefined || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** Coerce a fact + a comparison value to numbers for the ordered ops; null if either is non-numeric. */
function asNumbers(a: unknown, b: unknown): [number, number] | null {
  const na = typeof a === "number" ? a : typeof a === "string" && a.trim() !== "" ? Number(a) : NaN;
  const nb = typeof b === "number" ? b : typeof b === "string" && b.trim() !== "" ? Number(b) : NaN;
  return Number.isFinite(na) && Number.isFinite(nb) ? [na, nb] : null;
}

/** Evaluate one predicate against a resolved fact value. Defensive: an unknown op is always false. */
export function evaluateOne(op: ConditionOp, factValue: unknown, value: unknown): boolean {
  switch (op) {
    case "exists":
      return factValue !== undefined && factValue !== null;
    case "eq":
      return factValue === value || String(factValue) === String(value);
    case "neq":
      return !(factValue === value || String(factValue) === String(value));
    case "contains":
      return typeof factValue === "string" && typeof value === "string" && factValue.includes(value);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const pair = asNumbers(factValue, value);
      if (!pair) return false;
      const [a, b] = pair;
      return op === "gt" ? a > b : op === "gte" ? a >= b : op === "lt" ? a < b : a <= b;
    }
    default:
      return false;
  }
}

/** The result of evaluating a workflow's full condition list. */
export interface ConditionEvaluation {
  met: boolean;
  /** The 0-based index of the first condition that failed (for the run reason), or null if all met. */
  failedIndex: number | null;
}

/**
 * Evaluate the AND-list. An empty list is vacuously met (a workflow with no conditions always fires on
 * its trigger, like a #147 automation). Stops at the first failure so the reason points at it.
 */
export function evaluateConditions(
  conditions: WorkflowCondition[],
  facts: WorkflowFacts,
): ConditionEvaluation {
  for (let i = 0; i < conditions.length; i++) {
    const c = conditions[i]!;
    if (!evaluateOne(c.op, resolveFact(facts, c.fact), c.value)) {
      return { met: false, failedIndex: i };
    }
  }
  return { met: true, failedIndex: null };
}
