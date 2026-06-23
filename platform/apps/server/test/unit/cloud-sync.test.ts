import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diffManifests,
  mirror,
  hashContent,
  writeFileDurably,
  InMemoryMirrorSource,
  InMemoryMirrorSink,
  FsMirrorSink,
  type SyncManifest,
} from "../../src/workspace/sync.js";

/** Build a manifest from a {path: content} map (hashes computed like a real source). */
function manifestOf(files: Record<string, string>): SyncManifest {
  return {
    files: Object.entries(files).map(([path, content]) => ({
      path,
      hash: hashContent(content),
      size: Buffer.byteLength(content),
    })),
  };
}

describe("cloud↔local sync — manifest diff (#55)", () => {
  it("classifies new, changed (by hash), unchanged, and deleted files", () => {
    const remote = manifestOf({ "a.txt": "alpha", "b.txt": "BETA", "c.txt": "gamma" });
    const local = manifestOf({ "a.txt": "alpha", "b.txt": "beta", "old.txt": "stale" });

    const diff = diffManifests(remote, local);
    expect(diff.toWrite.sort()).toEqual(["b.txt", "c.txt"]); // b changed, c is new
    expect(diff.toRemove).toEqual(["old.txt"]); // not in remote
    expect(diff.unchanged).toBe(1); // a.txt identical
  });

  it("is a no-op when manifests are identical", () => {
    const m = manifestOf({ "a.txt": "alpha", "nested/b.txt": "beta" });
    const diff = diffManifests(m, m);
    expect(diff.toWrite).toEqual([]);
    expect(diff.toRemove).toEqual([]);
    expect(diff.unchanged).toBe(2);
  });
});

describe("cloud↔local sync — mirror to an in-memory sink", () => {
  it("applies writes and deletes so the sink matches the source", async () => {
    const source = new InMemoryMirrorSource({ "a.txt": "alpha", "dir/b.txt": "beta" });
    const sink = new InMemoryMirrorSink({ "a.txt": "OLD", "gone.txt": "remove me" });

    const result = await mirror(source, sink);

    expect(result.written.sort()).toEqual(["a.txt", "dir/b.txt"]);
    expect(result.removed).toEqual(["gone.txt"]);
    expect(sink.snapshot()).toEqual({ "a.txt": "alpha", "dir/b.txt": "beta" });

    // A second mirror is a clean no-op (idempotent).
    const again = await mirror(source, sink);
    expect(again.written).toEqual([]);
    expect(again.removed).toEqual([]);
    expect(again.unchanged).toBe(2);
  });
});

describe("cloud↔local sync — FsMirrorSink writes a real local directory", () => {
  const dirs: string[] = [];
  const makeDir = (): string => {
    const d = mkdtempSync(join(tmpdir(), "reload-mirror-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("mirrors files onto disk and removes ones dropped from the source", async () => {
    const root = makeDir();
    const sink = new FsMirrorSink(root);
    const source = new InMemoryMirrorSource({ "README.md": "# hi", "src/app.ts": "export {}" });

    await mirror(source, sink);
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("# hi");
    expect(readFileSync(join(root, "src/app.ts"), "utf8")).toBe("export {}");

    // Drop a file from the source → next mirror removes it locally.
    const shrunk = new InMemoryMirrorSource({ "README.md": "# hi" });
    const result = await mirror(shrunk, sink);
    expect(result.removed).toEqual(["src/app.ts"]);
    expect(existsSync(join(root, "src/app.ts"))).toBe(false);
  });

  it("refuses to write outside its root (path traversal is rejected)", async () => {
    const root = makeDir();
    const sink = new FsMirrorSink(root);
    await expect(sink.write("../escape.txt", "nope")).rejects.toThrow(/outside/i);
    expect(existsSync(join(root, "..", "escape.txt"))).toBe(false);
  });

  it("keeps the last committed file intact if a durable write fails before commit", async () => {
    const root = makeDir();
    const file = join(root, "state.json");

    await writeFileDurably(file, "{\"version\":1}");
    await expect(
      writeFileDurably(file, "{\"version\":2}", {
        rename: async () => {
          throw new Error("simulated crash before rename");
        },
      }),
    ).rejects.toThrow(/simulated crash/);

    expect(readFileSync(file, "utf8")).toBe("{\"version\":1}");
    expect(readdirSync(root).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });
});
