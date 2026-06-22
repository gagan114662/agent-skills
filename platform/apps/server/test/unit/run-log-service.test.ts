import { describe, expect, it } from "vitest";
import { InMemoryLogStore } from "../../src/observability/logs/store.js";
import { RunLogService, resolveRetentionDays } from "../../src/observability/logs/service.js";
import { LOG_LINE_MAX } from "../../src/observability/logs/redact.js";

const WS = "ws-1";
const RUN = "run-1";

/** A service over a fresh in-memory store with a frozen clock for deterministic timestamps/retention. */
function makeService(now = new Date("2026-06-22T12:00:00Z")) {
  const store = new InMemoryLogStore();
  const svc = new RunLogService(store, { now: () => now });
  return { store, svc, now };
}

describe("RunLogService.append (#665 durable lines)", () => {
  it("persists lines and reads them back with a poll cursor", async () => {
    const { svc } = makeService();
    await svc.append(WS, RUN, [{ text: "booting" }, { stream: "stderr", text: "warn: slow" }]);
    const log = await svc.getLog(WS, RUN);
    expect(log.runId).toBe(RUN);
    expect(log.lines.map((l) => [l.stream, l.text])).toEqual([
      ["stdout", "booting"],
      ["stderr", "warn: slow"],
    ]);
    expect(log.cursor).toBe(2);

    // Incremental tail from the cursor returns only what's new.
    await svc.append(WS, RUN, [{ text: "done" }]);
    const tail = await svc.getLog(WS, RUN, { afterSeq: log.cursor });
    expect(tail.lines.map((l) => l.text)).toEqual(["done"]);
  });

  it("redacts known secret values and caps long lines at the write door", async () => {
    const { svc } = makeService();
    await svc.append(WS, RUN, [{ text: "token is sk-supersecretvalue here" }], ["sk-supersecretvalue"]);
    await svc.append(WS, RUN, [{ text: "x".repeat(LOG_LINE_MAX + 500) }]);
    const log = await svc.getLog(WS, RUN);
    expect(log.lines[0]!.text).not.toContain("sk-supersecretvalue");
    expect(log.lines[0]!.text).toContain("‹redacted›");
    expect(log.lines[1]!.text.length).toBe(LOG_LINE_MAX);
  });

  it("is workspace-scoped: a foreign workspace cannot read the log (#3 IDOR)", async () => {
    const { svc } = makeService();
    await svc.append(WS, RUN, [{ text: "secret-ish line" }]);
    const log = await svc.getLog("ws-other", RUN);
    expect(log.lines).toEqual([]);
  });

  it("appending nothing is a no-op", async () => {
    const { svc } = makeService();
    expect(await svc.append(WS, RUN, [])).toEqual([]);
  });
});

describe("RunLogService.recordToolFailure (#666 failing tool call)", () => {
  it("pins the failing tool name + args + error onto the run", async () => {
    const { svc } = makeService();
    await svc.recordToolFailure(WS, RUN, {
      toolName: "web.fetch",
      args: { url: "https://example.com", method: "GET" },
      error: "ETIMEDOUT after 30s",
    });
    const failure = await svc.getFailure(WS, RUN);
    expect(failure).toMatchObject({
      toolName: "web.fetch",
      error: "ETIMEDOUT after 30s",
      args: { url: "https://example.com", method: "GET" },
    });
  });

  it("redacts sensitive keys and secret values in the captured args", async () => {
    const { svc } = makeService();
    await svc.recordToolFailure(
      WS,
      RUN,
      {
        toolName: "http.post",
        args: { authorization: "Bearer abc", body: "uses sk-leakedsecretvalue inside" },
        error: "401 from sk-leakedsecretvalue",
      },
      ["sk-leakedsecretvalue"],
    );
    const failure = await svc.getFailure(WS, RUN);
    expect(failure!.args.authorization).toBe("‹redacted-key›"); // sensitive KEY masked
    expect(JSON.stringify(failure!.args)).not.toContain("sk-leakedsecretvalue"); // secret VALUE scrubbed
    expect(failure!.error).not.toContain("sk-leakedsecretvalue");
  });

  it("upserts — re-recording overwrites with the latest failure", async () => {
    const { svc } = makeService();
    await svc.recordToolFailure(WS, RUN, { toolName: "a", error: "first" });
    await svc.recordToolFailure(WS, RUN, { toolName: "b", error: "second" });
    expect(await svc.getFailure(WS, RUN)).toMatchObject({ toolName: "b", error: "second" });
  });

  it("returns null for a successful run (no failure recorded)", async () => {
    const { svc } = makeService();
    expect(await svc.getFailure(WS, RUN)).toBeNull();
  });
});

describe("RunLogService retention (#665)", () => {
  it("prunes lines + failures older than the retention window", async () => {
    const now = new Date("2026-06-22T12:00:00Z");
    const { svc } = makeService(now);
    const old = new Date("2026-05-01T00:00:00Z"); // > 30 days before now
    const recent = new Date("2026-06-20T00:00:00Z");
    await svc.append(WS, RUN, [
      { text: "stale", occurredAt: old },
      { text: "fresh", occurredAt: recent },
    ]);
    const removed = await svc.pruneByRetention(30);
    expect(removed).toBe(1);
    const log = await svc.getLog(WS, RUN);
    expect(log.lines.map((l) => l.text)).toEqual(["fresh"]);
  });

  it("pruneOlderThan removes by an explicit cutoff", async () => {
    const { svc } = makeService();
    await svc.append(WS, RUN, [
      { text: "old", occurredAt: new Date("2026-01-01T00:00:00Z") },
      { text: "new", occurredAt: new Date("2026-06-01T00:00:00Z") },
    ]);
    expect(await svc.pruneOlderThan(new Date("2026-03-01T00:00:00Z"))).toBe(1);
  });
});

describe("resolveRetentionDays", () => {
  it("defaults to 30 and respects a positive env override", () => {
    const original = process.env.OBSERVABILITY_LOG_RETENTION_DAYS;
    try {
      delete process.env.OBSERVABILITY_LOG_RETENTION_DAYS;
      expect(resolveRetentionDays()).toBe(30);
      process.env.OBSERVABILITY_LOG_RETENTION_DAYS = "7";
      expect(resolveRetentionDays()).toBe(7);
      process.env.OBSERVABILITY_LOG_RETENTION_DAYS = "garbage";
      expect(resolveRetentionDays()).toBe(30);
    } finally {
      if (original === undefined) delete process.env.OBSERVABILITY_LOG_RETENTION_DAYS;
      else process.env.OBSERVABILITY_LOG_RETENTION_DAYS = original;
    }
  });
});
