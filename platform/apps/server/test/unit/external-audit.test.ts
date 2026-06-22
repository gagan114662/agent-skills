import { describe, it, expect } from "vitest";

import {
  canonicalize,
  computeHash,
  contentOf,
  GENESIS_HASH,
  sealRecord,
  verifyChain,
} from "../../src/external-audit/chain.js";
import { toAuditExport, toNdjson } from "../../src/external-audit/export.js";
import { ExternalActionAuditLog } from "../../src/external-audit/service.js";
import { InMemoryAuditLogStore } from "../../src/external-audit/store.js";
import type { AuditRecord, ExternalActionInput } from "../../src/external-audit/types.js";

/** A monotonic, deterministic clock so sealed timestamps are pinned in tests. */
function fixedClock(startMs = Date.parse("2026-06-22T00:00:00.000Z")) {
  let t = startMs;
  return () => new Date((t += 1000));
}

function input(over: Partial<ExternalActionInput> = {}): ExternalActionInput {
  return {
    workspaceId: "ws1",
    actor: { type: "agent", id: "agent1", label: "SEO Scout" },
    kind: "publish",
    target: "https://ipop.ai/blog/launch",
    summary: "Published launch post",
    receipt: { type: "url", value: "https://ipop.ai/blog/launch" },
    ...over,
  };
}

describe("external-audit chain (#672)", () => {
  it("canonicalizes objects with sorted keys regardless of insertion order", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
    expect(canonicalize({ a: { y: 1, x: 2 } })).toBe('{"a":{"x":2,"y":1}}');
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]"); // array order preserved
    expect(canonicalize(null)).toBe("null");
  });

  it("seals the first record against genesis and links subsequent records", () => {
    const r1 = sealRecord(null, input(), "2026-06-22T00:00:01.000Z");
    expect(r1.seq).toBe(1);
    expect(r1.prevHash).toBe(GENESIS_HASH);
    expect(r1.hash).toMatch(/^[0-9a-f]{64}$/);

    const r2 = sealRecord(r1, input({ kind: "send", target: "user@example.com" }), "2026-06-22T00:00:02.000Z");
    expect(r2.seq).toBe(2);
    expect(r2.prevHash).toBe(r1.hash);
    expect(r2.hash).not.toBe(r1.hash);
  });

  it("hash is deterministic for identical content", () => {
    const r1 = sealRecord(null, input(), "2026-06-22T00:00:01.000Z");
    const again = sealRecord(null, input(), "2026-06-22T00:00:01.000Z");
    expect(again.hash).toBe(r1.hash);
  });

  it("verifies an intact chain", () => {
    const r1 = sealRecord(null, input(), "2026-06-22T00:00:01.000Z");
    const r2 = sealRecord(r1, input({ kind: "spend" }), "2026-06-22T00:00:02.000Z");
    expect(verifyChain([r1, r2])).toEqual({ ok: true, length: 2 });
    expect(verifyChain([])).toEqual({ ok: true, length: 0 });
  });

  it("detects a tampered field (hash mismatch)", () => {
    const r1 = sealRecord(null, input(), "2026-06-22T00:00:01.000Z");
    const r2 = sealRecord(r1, input(), "2026-06-22T00:00:02.000Z");
    const forged: AuditRecord = { ...r2, target: "https://evil.example/redirect" };
    const result = verifyChain([r1, forged]);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toEqual({ seq: 2, reason: "hash_mismatch" });
  });

  it("detects a removed record (broken link)", () => {
    const r1 = sealRecord(null, input(), "2026-06-22T00:00:01.000Z");
    const r2 = sealRecord(r1, input(), "2026-06-22T00:00:02.000Z");
    const r3 = sealRecord(r2, input(), "2026-06-22T00:00:03.000Z");
    // Drop r2 and renumber r3 → seq stays contiguous but the prevHash no longer matches r1.
    const tampered: AuditRecord = { ...r3, seq: 2 };
    const result = verifyChain([r1, tampered]);
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toEqual({ seq: 2, reason: "broken_link" });
  });

  it("detects a non-contiguous sequence", () => {
    const r1 = sealRecord(null, input(), "2026-06-22T00:00:01.000Z");
    const result = verifyChain([{ ...r1, seq: 5 }]);
    expect(result.ok).toBe(false);
    expect(result.brokenAt?.reason).toBe("bad_sequence");
  });

  it("computeHash folds in prevHash (same content, different predecessor ⇒ different hash)", () => {
    const base = sealRecord(null, input(), "2026-06-22T00:00:01.000Z");
    const content = contentOf(base);
    const a = computeHash({ ...content, prevHash: "AAAA" });
    const b = computeHash({ ...content, prevHash: "BBBB" });
    expect(a).not.toBe(b);
  });
});

describe("ExternalActionAuditLog service (#672)", () => {
  it("records an append-only, tamper-evident chain capturing actor/time/target/receipt", async () => {
    const log = new ExternalActionAuditLog({ store: new InMemoryAuditLogStore(), clock: fixedClock() });

    const rec = await log.record(input());
    expect(rec).toMatchObject({
      seq: 1,
      workspaceId: "ws1",
      actor: { type: "agent", id: "agent1", label: "SEO Scout" },
      kind: "publish",
      target: "https://ipop.ai/blog/launch",
      receipt: { type: "url", value: "https://ipop.ai/blog/launch" },
      prevHash: GENESIS_HASH,
    });
    expect(rec.at).toBe("2026-06-22T00:00:01.000Z");

    await log.record(input({ kind: "send", target: "user@example.com", summary: "Sent welcome email" }));
    const all = await log.list({ workspaceId: "ws1" });
    expect(all.map((r) => r.seq)).toEqual([1, 2]);
    expect(all[1].prevHash).toBe(all[0].hash);
    expect((await log.verify("ws1")).ok).toBe(true);
  });

  it("defaults metadata/receipt so a minimal record still seals", async () => {
    const log = new ExternalActionAuditLog({ clock: fixedClock() });
    const rec = await log.record({
      workspaceId: "ws1",
      actor: { type: "system", id: null, label: "system" },
      kind: "api_call",
      target: "stripe.com",
      summary: "Created customer",
    });
    expect(rec.receipt).toBeNull();
    expect(rec.metadata).toEqual({});
    expect((await log.verify("ws1")).ok).toBe(true);
  });

  it("isolates chains per workspace", async () => {
    const log = new ExternalActionAuditLog({ clock: fixedClock() });
    await log.record(input({ workspaceId: "ws1" }));
    await log.record(input({ workspaceId: "ws2" }));
    await log.record(input({ workspaceId: "ws1" }));

    const ws1 = await log.list({ workspaceId: "ws1" });
    const ws2 = await log.list({ workspaceId: "ws2" });
    expect(ws1.map((r) => r.seq)).toEqual([1, 2]);
    expect(ws2.map((r) => r.seq)).toEqual([1]);
    expect((await log.verify("ws1")).ok).toBe(true);
    expect((await log.verify("ws2")).ok).toBe(true);
  });

  it("serializes concurrent records into one unbroken chain", async () => {
    const log = new ExternalActionAuditLog({ clock: fixedClock() });
    await Promise.all(Array.from({ length: 25 }, (_, i) => log.record(input({ summary: `action ${i}` }))));
    const all = await log.list({ workspaceId: "ws1" });
    expect(all.map((r) => r.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect((await log.verify("ws1")).ok).toBe(true);
  });

  it("exports NDJSON that re-verifies offline", async () => {
    const log = new ExternalActionAuditLog({ clock: fixedClock() });
    await log.record(input());
    await log.record(input({ kind: "post", target: "x.com/ipop" }));

    const ndjson = await log.exportNdjson("ws1");
    const lines = ndjson.split("\n");
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l) as AuditRecord);
    expect(verifyChain(parsed).ok).toBe(true);
    expect(toNdjson(parsed)).toBe(ndjson);
  });

  it("exports a self-describing bundle with an integrity stamp", async () => {
    const log = new ExternalActionAuditLog({ clock: fixedClock() });
    const r1 = await log.record(input());
    const r2 = await log.record(input({ kind: "spend", summary: "Ad spend $20" }));

    const bundle = await log.exportBundle("ws1");
    expect(bundle).toMatchObject({
      format: "external-audit/v1",
      workspaceId: "ws1",
      count: 2,
      head: r2.hash,
      verification: { ok: true, length: 2 },
    });
    expect(bundle.records[0].hash).toBe(r1.hash);

    // A bundle exported from tampered records reports ok:false rather than silently passing.
    const tampered = toAuditExport([r1, { ...r2, summary: "edited" }], "ws1");
    expect(tampered.verification.ok).toBe(false);
  });
});
