import { describe, expect, it, vi } from "vitest";
import { REDACTION_MASK } from "../../src/runtime/redact.js";
import {
  evaluateDogfoodRun,
  isDogfoodAutopublishArmed,
  processDogfoodRun,
  type DogfoodEvaluatorConfig,
  type DogfoodRunInput,
} from "../../src/dogfood-evaluator/index.js";

const baseConfig: DogfoodEvaluatorConfig = {
  targetRepo: { owner: "gagan114662", repo: "agent-skills" },
  existingIssues: [],
  publishMode: "review",
};

describe("#1196 ipop dogfood evaluator", () => {
  it("dedupes seeded runs against existing open issues instead of drafting duplicates", () => {
    const run: DogfoodRunInput = {
      id: "run-dedupe",
      lane: "ipop-growth",
      task: "Use Gmail to start outreach for ipop.ai customer acquisition",
      agents: ["scout", "postmark"],
      tools: [{ name: "browser", output: "Gmail connection is coming soon" }],
      artifacts: [{ kind: "note", title: "Outreach plan", content: "coming soon placeholder" }],
      receipts: [{ kind: "trace", url: "https://trace.local/run-dedupe" }],
    };

    const evaluation = evaluateDogfoodRun(run, {
      ...baseConfig,
      existingIssues: [
        {
          number: 395,
          title: "connect/enable one real outbound channel",
          body: "Gmail outreach has no real permitted sender and should not show mock success.",
          labels: ["outreach"],
          url: "https://github.com/gagan114662/agent-skills/issues/395",
        },
      ],
    });

    expect(evaluation.existingIssue?.number).toBe(395);
    expect(evaluation.issueDraft).toBeUndefined();
  });

  it("creates a review-mode draft for a novel real-marketing failure with receipts and AC", () => {
    const evaluation = evaluateDogfoodRun(
      {
        id: "run-novel",
        lane: "ipop-growth",
        task: "Have ipop agents grow ipop.ai by publishing a launch comparison page",
        goal: "Create SEO and social leverage",
        agents: ["scout", "quill"],
        tools: [{ name: "browser", output: "Preview failed repeatedly with 404" }],
        publicOutputs: [{ surface: "public site", url: "https://ipop.ai/stories", content: "..." }],
        traces: [{ id: "trace-novel", url: "https://traces.local/run-novel" }],
      },
      baseConfig,
    );

    expect(evaluation.lane).toBe("ipop-growth");
    expect(evaluation.marketingLeverage).toEqual(expect.arrayContaining(["seo", "social", "site"]));
    expect(evaluation.failures.map((failure) => failure.kind)).toEqual(
      expect.arrayContaining(["no_deliverable", "no_receipt", "placeholder_output", "broken_route"]),
    );
    expect(evaluation.issueDraft?.title).toContain("Dogfood gap");
    expect(evaluation.issueDraft?.body).toContain("## Observation");
    expect(evaluation.issueDraft?.body).toContain("## Expected behavior");
    expect(evaluation.issueDraft?.body).toContain("## Acceptance criteria");
    expect(evaluation.issueDraft?.body).toContain("https://traces.local/run-novel");
  });

  it("keeps autopublish behind repo config and only calls the injected publisher when armed", async () => {
    const run: DogfoodRunInput = {
      id: "run-publish",
      lane: "ipop-growth",
      task: "Use Reddit to find customers for ipop.ai",
      agents: ["scout"],
    };
    const publisher = { createIssue: vi.fn(async () => ({ number: 1197, url: "https://issue.local/1197" })) };

    const disabled = await processDogfoodRun(
      run,
      { ...baseConfig, publishMode: "autopublish", autopublishEnabled: false },
      publisher,
    );
    expect(isDogfoodAutopublishArmed({ ...baseConfig, publishMode: "autopublish", autopublishEnabled: false })).toBe(
      false,
    );
    expect(disabled.publication).toBeUndefined();
    expect(publisher.createIssue).not.toHaveBeenCalled();

    const enabled = await processDogfoodRun(
      run,
      { ...baseConfig, publishMode: "autopublish", autopublishEnabled: true },
      publisher,
    );
    expect(isDogfoodAutopublishArmed({ ...baseConfig, publishMode: "autopublish", autopublishEnabled: true })).toBe(
      true,
    );
    expect(enabled.publication?.number).toBe(1197);
    expect(publisher.createIssue).toHaveBeenCalledTimes(1);
  });

  it("redacts private traces, secret values, and token-shaped payloads before issue filing", () => {
    const secret = "sk-live-DOGFOOD-SECRET-123456";
    const evaluation = evaluateDogfoodRun(
      {
        id: "run-redact",
        lane: "ipop-growth",
        task: `Publish launch copy using ${secret}`,
        agents: ["quill"],
        artifacts: [
          {
            kind: "copy",
            title: "Launch copy",
            content: `TODO placeholder. OPENAI_API_KEY=${secret}`,
          },
        ],
        traces: [{ id: "trace-redact", authorization: `Bearer ${secret}`, url: "https://trace.local/redact" }],
        secretValues: [secret],
      },
      baseConfig,
    );

    const serialized = JSON.stringify(evaluation);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("OPENAI_API_KEY=sk-live");
    expect(serialized).toContain(REDACTION_MASK);
    expect(evaluation.issueDraft?.body).toContain(REDACTION_MASK);
  });
});
