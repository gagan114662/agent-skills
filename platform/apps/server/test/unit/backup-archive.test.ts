import { describe, it, expect } from "vitest";
import {
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  buildEnvelope,
  canonicalize,
  checksumSnapshot,
  collectionCounts,
  countRows,
  parseEnvelope,
  serializeEnvelope,
  verifyEnvelope,
  type ExportEnvelope,
  type WorkspaceSnapshot,
} from "../../src/backup/archive.js";

/**
 * Pure unit tests of the export envelope (issue #676): the checksum is deterministic and order-independent,
 * a freshly built envelope verifies, and every kind of corruption (format, version, missing field, tampered
 * snapshot) is refused fail-closed.
 */

const SNAPSHOT: WorkspaceSnapshot = {
  collections: {
    agent_sessions: [{ id: "s1", status: "done" }, { id: "s2", status: "failed" }],
    automations: [{ id: "a1", name: "nightly" }],
  },
};
const AT = new Date("2026-06-22T00:00:00.000Z");

describe("canonicalize / checksum", () => {
  it("is independent of object key insertion order", () => {
    const a = canonicalize({ b: 1, a: 2, c: { y: 1, x: 2 } });
    const b = canonicalize({ c: { x: 2, y: 1 }, a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it("preserves array order (meaningful)", () => {
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  it("produces the same checksum for the same snapshot", () => {
    expect(checksumSnapshot(SNAPSHOT)).toBe(checksumSnapshot(SNAPSHOT));
  });

  it("changes the checksum when a row changes", () => {
    const tampered: WorkspaceSnapshot = {
      collections: { ...SNAPSHOT.collections, automations: [{ id: "a1", name: "HIJACKED" }] },
    };
    expect(checksumSnapshot(tampered)).not.toBe(checksumSnapshot(SNAPSHOT));
  });
});

describe("countRows / collectionCounts", () => {
  it("counts rows across collections", () => {
    expect(countRows(SNAPSHOT)).toBe(3);
    expect(collectionCounts(SNAPSHOT)).toEqual({ agent_sessions: 2, automations: 1 });
  });
});

describe("buildEnvelope / verifyEnvelope", () => {
  it("builds a well-formed, self-verifying envelope", () => {
    const env = buildEnvelope("ws-1", SNAPSHOT, AT);
    expect(env.format).toBe(EXPORT_FORMAT);
    expect(env.version).toBe(EXPORT_FORMAT_VERSION);
    expect(env.workspaceId).toBe("ws-1");
    expect(env.createdAt).toBe(AT.toISOString());
    expect(env.checksum).toBe(checksumSnapshot(SNAPSHOT));
    expect(verifyEnvelope(env)).toEqual({ ok: true });
  });

  it("rejects a non-object", () => {
    expect(verifyEnvelope(null)).toEqual({ ok: false, reason: "not an object" });
  });

  it("rejects an unrecognized format", () => {
    const env = { ...buildEnvelope("ws-1", SNAPSHOT, AT), format: "evil" };
    expect(verifyEnvelope(env)).toMatchObject({ ok: false, reason: "unrecognized format" });
  });

  it("rejects an unsupported version", () => {
    const env = { ...buildEnvelope("ws-1", SNAPSHOT, AT), version: 999 };
    expect(verifyEnvelope(env)).toMatchObject({ ok: false });
  });

  it("rejects a missing workspaceId", () => {
    const env = { ...buildEnvelope("ws-1", SNAPSHOT, AT), workspaceId: "" };
    expect(verifyEnvelope(env)).toMatchObject({ ok: false, reason: "missing workspaceId" });
  });

  it("rejects a malformed snapshot", () => {
    const env = { ...buildEnvelope("ws-1", SNAPSHOT, AT), snapshot: { collections: { x: "not-array" } } };
    expect(verifyEnvelope(env)).toMatchObject({ ok: false, reason: "malformed snapshot" });
  });

  it("rejects a tampered snapshot whose checksum no longer matches", () => {
    const env = buildEnvelope("ws-1", SNAPSHOT, AT);
    const tampered: ExportEnvelope = {
      ...env,
      snapshot: { collections: { ...env.snapshot.collections, automations: [{ id: "a1", name: "HIJACKED" }] } },
    };
    expect(verifyEnvelope(tampered)).toMatchObject({ ok: false, reason: "checksum mismatch" });
  });
});

describe("serialize / parse round-trip", () => {
  it("round-trips a valid envelope", () => {
    const env = buildEnvelope("ws-1", SNAPSHOT, AT);
    const parsed = parseEnvelope(serializeEnvelope(env));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.envelope).toEqual(env);
  });

  it("rejects invalid JSON", () => {
    expect(parseEnvelope("{not json")).toEqual({ ok: false, reason: "invalid JSON" });
  });

  it("rejects serialized bytes with a tampered checksum", () => {
    const env = buildEnvelope("ws-1", SNAPSHOT, AT);
    const corrupt = serializeEnvelope(env).replace(env.checksum, "0".repeat(env.checksum.length));
    expect(parseEnvelope(corrupt)).toMatchObject({ ok: false, reason: "checksum mismatch" });
  });
});
