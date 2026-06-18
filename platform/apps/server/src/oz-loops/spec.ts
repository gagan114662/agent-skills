/**
 * Spec-generation loop (#356, ADR-0356) — **pure**, adapted from oz-for-oss's `create-product-spec` /
 * `create-tech-spec` skills. Turns an issue (title + untrusted body) into an ADVISORY DRAFT spec the owner
 * reviews and edits — it is never posted, and opening an issue/PR from it goes through #13. The body is
 * quarantined DATA and only echoed back inside a clearly-labelled "Context (verbatim, untrusted)" block; an
 * instruction-injection attempt is flagged in the draft, not followed (#200 §6). Deterministic; no IO.
 */
import type { SpecInput, SpecProposal, SpecKind } from "./contract.js";
import { quarantine, sanitizeLine } from "./sanitize.js";

/** The section skeleton for each spec kind (oz-for-oss product vs tech spec shapes). */
const SECTIONS: Record<SpecKind, readonly string[]> = {
  product: ["Problem", "Goals", "Non-Goals", "Users & Use Cases", "Success Metrics", "Open Questions"],
  tech: ["Context", "Proposed Approach", "Alternatives Considered", "Data & API Changes", "Risks & Rollout", "Test Plan", "Open Questions"],
};

/**
 * Build an advisory DRAFT spec. Pure: same input ⇒ same draft. The draft is a SCAFFOLD — every section is a
 * prompt for the human author, and the only place untrusted input appears is a quarantined verbatim block.
 */
export function decideSpecDraft(input: SpecInput): SpecProposal {
  const title = sanitizeLine(input.title);
  const body = quarantine(input.body);
  const sections = [...SECTIONS[input.specKind]];

  const lines: string[] = [];
  lines.push(`# ${input.specKind === "product" ? "Product" : "Tech"} Spec (DRAFT): ${title}`);
  lines.push("");
  lines.push("> Auto-drafted scaffold from issue context. **Advisory — review & edit before use.**");
  if (body.injectionFlagged) {
    lines.push(">");
    lines.push("> ⚠ The source content tried to instruct the agent; it was treated as DATA, not followed.");
  }
  lines.push("");
  for (const section of sections) {
    lines.push(`## ${section}`);
    lines.push("");
    lines.push("_TODO: fill in._");
    lines.push("");
  }
  lines.push("## Context (verbatim, untrusted)");
  lines.push("");
  lines.push("```text");
  lines.push(body.text || "(no body provided)");
  lines.push("```");

  return {
    kind: "spec",
    advisory: true,
    injectionFlagged: body.injectionFlagged,
    specKind: input.specKind,
    sections,
    draftMarkdown: lines.join("\n"),
    summary: sanitizeLine(`Draft ${input.specKind} spec for "${title}" (${sections.length} sections)`, 200),
  };
}
