import { describe, it, expect } from "vitest";
import {
  reduceMarketingTasksToSamples,
  taskStatusSucceeded,
  type HarvestableTaskRecord,
} from "../../src/skillopt/harvest.js";
import { mineRecurringTasks } from "../../src/skillopt/mine.js";

function row(over: Partial<HarvestableTaskRecord> = {}): HarvestableTaskRecord {
  return {
    id: over.id ?? "t-1",
    workspaceId: over.workspaceId ?? "ws-owner",
    department: over.department ?? "seo",
    task: over.task ?? "Audit the homepage for SEO issues",
    status: over.status ?? "done",
  };
}

/** True iff any C0/C1 control char survived in the string (the injection vector). */
function hasControlChar(text: string): boolean {
  return [...text].some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
}

describe("skillopt/harvest — taskStatusSucceeded", () => {
  it("is true only for the `done` terminal status (a mining weight, never a metric)", () => {
    expect(taskStatusSucceeded("done")).toBe(true);
    expect(taskStatusSucceeded("launched")).toBe(false);
    expect(taskStatusSucceeded("failed")).toBe(false);
    expect(taskStatusSucceeded("blocked")).toBe(false);
    expect(taskStatusSucceeded("")).toBe(false);
  });
});

describe("skillopt/harvest — reduceMarketingTasksToSamples", () => {
  it("maps a department's rows into samples stamped with the agent handle", () => {
    const samples = reduceMarketingTasksToSamples(
      [row({ id: "a" }), row({ id: "b", status: "launched" })],
      "scout",
      "seo",
    );
    expect(samples).toEqual([
      {
        sampleId: "a",
        workspaceId: "ws-owner",
        agentHandle: "scout",
        taskText: "Audit the homepage for SEO issues",
        succeeded: true,
      },
      {
        sampleId: "b",
        workspaceId: "ws-owner",
        agentHandle: "scout",
        taskText: "Audit the homepage for SEO issues",
        succeeded: false, // launched (still running) is not a success weight
      },
    ]);
  });

  it("drops rows that belong to a different department — never crosses the streams", () => {
    const samples = reduceMarketingTasksToSamples(
      [row({ id: "a", department: "seo" }), row({ id: "b", department: "social" })],
      "scout",
      "seo",
    );
    expect(samples.map((s) => s.sampleId)).toEqual(["a"]);
  });

  it("sanitizes the brief text to DATA (control chars stripped, whitespace collapsed) — #200 §6", () => {
    // Build the control chars programmatically — literal C0/C1 bytes get mangled when written to source.
    const ESC = String.fromCharCode(0x1b); // ANSI escape — the directive-smuggling vector
    const NUL = String.fromCharCode(0x00);
    const BEL = String.fromCharCode(0x07);
    const poisoned = row({
      id: "p",
      task: `Audit${ESC}[31m the${NUL}${BEL}   homepage\n\nfor SEO`,
    });
    const [s] = reduceMarketingTasksToSamples([poisoned], "scout", "seo");
    expect(s).toBeDefined();
    // Control chars become spaces, then whitespace collapses to single spaces.
    expect(s!.taskText).toBe("Audit [31m the homepage for SEO");
    expect(hasControlChar(s!.taskText)).toBe(false);
  });

  it("drops a row whose objective sanitizes to empty (e.g. all control chars) — nothing minable", () => {
    const samples = reduceMarketingTasksToSamples(
      [row({ id: "empty", task: "    " }), row({ id: "ok" })],
      "scout",
      "seo",
    );
    expect(samples.map((s) => s.sampleId)).toEqual(["ok"]);
  });

  it("bounds the batch at maxSamples (newest-first inputs assumed; tail dropped)", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row({ id: `r-${i}` }));
    const samples = reduceMarketingTasksToSamples(rows, "scout", "seo", { maxSamples: 3 });
    expect(samples.map((s) => s.sampleId)).toEqual(["r-0", "r-1", "r-2"]);
  });

  it("returns [] for an empty batch", () => {
    expect(reduceMarketingTasksToSamples([], "scout", "seo")).toEqual([]);
  });

  it("feeds straight into mining: recurring real briefs cluster, volatile tokens collapse", () => {
    // Three real briefs that are 'the same task about a different page/number' → one recurring cluster.
    const rows = [
      row({ id: "1", task: "Audit page 5 at https://ipop.ai/a for SEO issues" }),
      row({ id: "2", task: "Audit page 9 at https://ipop.ai/b for SEO issues" }),
      row({ id: "3", task: "Audit page 12 at https://ipop.ai/c for SEO issues" }),
      row({ id: "4", task: "Write the brand voice guide" }), // one-off, not recurring
    ];
    const samples = reduceMarketingTasksToSamples(rows, "scout", "seo");
    const clusters = mineRecurringTasks(samples, "scout", { minRecurrence: 3 });
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.count).toBe(3);
    expect(clusters[0]!.sampleIds).toEqual(["1", "2", "3"]);
  });
});
