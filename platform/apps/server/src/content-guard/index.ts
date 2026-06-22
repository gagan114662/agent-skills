/**
 * Content guard (issue #674) — the prompt-injection trust boundary for externally-fetched content. This is
 * the module barrel: import everything from here. The pieces compose into one rule a caller should follow at
 * every web/email ingress:
 *
 *   1. Wrap fetched text at the boundary:        const u = asUntrusted({ source: "web", origin: url, raw });
 *   2. Neutralize before it touches a prompt:    const safe = ingestExternalContent(u);   // fences + scans
 *   3. Embed only `safe.neutralized.safeText`;   never the raw text.
 *   4. Gate every action shaped by it:           const d = gateAction({ type, derivedFromExternal: true,
 *                                                  injectionSeverity: safe.neutralized.scan.severity });
 *      — `d.requiresApproval` ⇒ route through the #13 approval queue; `d.blocked` ⇒ refuse.
 *
 * The three layers are independent on purpose (#200 §6 defense-in-depth): detection can miss, the model can be
 * fooled by the fence, but the GATE still guarantees no autonomous action ever comes from external content.
 *
 * Nothing here does IO or wires into a route/registry — it is a pure library other modules call, which is why
 * the #674 change set touches no migration, schema barrel, or app-wiring file.
 */

import { randomUUID } from "node:crypto";

import { resolveGatePolicy } from "./caps.js";
import { gateAction, type GateDecision, type ProposedAction } from "./gate.js";
import { neutralizeContent, type NeutralizedContent } from "./neutralize.js";
import { asUntrusted, type AsUntrustedInput, type UntrustedContent } from "./trust.js";

export * from "./trust.js";
export * from "./detect.js";
export * from "./neutralize.js";
export * from "./gate.js";
export { resolveGatePolicy } from "./caps.js";

/** The bundle returned by {@link ingestExternalContent}: the wrapper plus its neutralized, scanned form. */
export interface IngestedContent {
  untrusted: UntrustedContent;
  neutralized: NeutralizedContent;
}

/**
 * The one-call ingress helper: wrap (if needed), then neutralize with a fresh random fence nonce so the fence
 * cannot be forged from inside the content. Accepts either an already-wrapped {@link UntrustedContent} or the
 * raw {@link AsUntrustedInput}. This is the production binding that supplies the nonce the pure neutralizer
 * leaves injectable for tests.
 */
export function ingestExternalContent(input: UntrustedContent | AsUntrustedInput): IngestedContent {
  const untrusted = isUntrusted(input) ? input : asUntrusted(input);
  const neutralized = neutralizeContent(untrusted, { nonce: randomUUID() });
  return { untrusted, neutralized };
}

/**
 * Gate an action that was shaped by an already-ingested piece of external content. Forces
 * `derivedFromExternal: true` and feeds the detector's severity into the gate, applying the env-resolved
 * hard-block policy. This is the convenience path that makes the safe thing the easy thing — a caller cannot
 * accidentally forget to mark the action as external-derived.
 */
export function gateExternalAction(
  ingested: IngestedContent,
  action: Omit<ProposedAction, "derivedFromExternal" | "provenance" | "injectionSeverity">,
  env: NodeJS.ProcessEnv = process.env,
): GateDecision {
  return gateAction(
    {
      ...action,
      derivedFromExternal: true,
      provenance: "external",
      injectionSeverity: ingested.neutralized.scan.severity,
    },
    resolveGatePolicy(env),
  );
}

function isUntrusted(input: UntrustedContent | AsUntrustedInput): input is UntrustedContent {
  return (input as { __brand?: unknown }).__brand === "UntrustedContent";
}
