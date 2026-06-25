import { describe, expect, it } from "vitest";
import { createDefaultIndependentGrader } from "../../src/verification/content-grader.js";
import { deriveDefinitionOfDone } from "../../src/verification/criteria.js";
import type { Deliverable } from "../../src/verification/engine.js";

const grader = createDefaultIndependentGrader("grader-854");

const outbound = (over: Partial<Deliverable> = {}): Deliverable => ({
  workspaceId: "ws-1",
  deliverableRef: "draft-1",
  deliverableKind: "outbound_content",
  workerMemberId: "worker-1",
  content:
    "We help busy founders turn messy marketing ideas into a clear weekly plan, with drafts ready for review.",
  ...over,
});

describe("default verification content grader (#854)", () => {
  it("fails the originality criterion when outbound content copies a known source", async () => {
    const source =
      "We help busy founders turn messy marketing ideas into a clear weekly plan, with drafts ready for review.";
    const dod = deriveDefinitionOfDone({ deliverableKind: "outbound_content", brief: "Draft homepage copy." });

    const result = await grader.grade({
      dod,
      deliverable: outbound({ content: source, originalitySources: [{ id: "competitor-homepage", text: source }] }),
    });

    const originality = result.observations.find((o) => o.criterionId === "originality");
    expect(originality).toMatchObject({ satisfied: false });
    expect(originality?.evidence).toContain("competitor-homepage");
    expect(originality?.evidence).toContain("too similar");
  });

  it("passes originality when the closest known source is below the similarity threshold", async () => {
    const dod = deriveDefinitionOfDone({ deliverableKind: "outbound_content", brief: "Draft homepage copy." });

    const result = await grader.grade({
      dod,
      deliverable: outbound({
        originalitySources: [
          {
            id: "competitor-homepage",
            text:
              "Enterprise payroll software for finance teams with tax filing, employee benefits, and HR reports.",
          },
        ],
      }),
    });

    expect(result.observations.find((o) => o.criterionId === "originality")).toMatchObject({
      satisfied: true,
    });
  });

  it("fails brand_safe when the configured brand voice forbids a phrase used in the draft", async () => {
    const dod = deriveDefinitionOfDone({ deliverableKind: "outbound_content", brief: "Draft launch copy." });

    const result = await grader.grade({
      dod,
      deliverable: outbound({
        brandVoice: "Warm and plain. Never say \"guaranteed results\".",
        content:
          "Our team writes careful launch drafts for founders. We promise guaranteed results for every campaign.",
      }),
    });

    const brandSafe = result.observations.find((o) => o.criterionId === "brand_safe");
    expect(brandSafe).toMatchObject({ satisfied: false });
    expect(brandSafe?.evidence).toContain("guaranteed results");
  });

  it("fails closed for criteria the local verifier cannot actually grade", async () => {
    const result = await grader.grade({
      deliverable: outbound(),
      dod: {
        deliverableKind: "outbound_content",
        reversibility: "irreversible",
        criteria: [{ id: "custom_claim", text: "custom claim", category: "content", required: true }],
      },
    });

    expect(result.observations[0]).toMatchObject({
      criterionId: "custom_claim",
      satisfied: false,
      confidence: 0,
    });
    expect(result.observations[0]?.evidence).toContain("failing closed");
  });
});
