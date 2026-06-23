import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/**
 * Cloud↔local file sync / mirroring (issue #55, ADR-0032).
 *
 * Mirroring is a content-hash manifest diff: the cloud is a {@link MirrorSource}, the local
 * directory is a {@link MirrorSink}, and {@link mirror} applies the difference (write changed/new
 * files, remove deleted ones). It is transport-agnostic — the real cloud source is a thin adapter
 * over the #25 sandbox/snapshot, while tests inject the in-memory fakes here (no cloud spend).
 *
 * Secrets are out of scope by construction: #25 keeps secrets env-injected and out of snapshots,
 * so the file set a source exposes never contains a secret, and this layer never logs file content.
 */

/** One file's identity in a manifest: its path (POSIX-relative) and content hash. */
export interface SyncFile {
  path: string;
  hash: string;
  size: number;
}

/** The full file listing of a workspace at a point in time. */
export interface SyncManifest {
  files: SyncFile[];
}

/** The cloud side: lists files and reads their content on demand. */
export interface MirrorSource {
  manifest(): Promise<SyncManifest>;
  read(path: string): Promise<string>;
}

/** The local side: lists its current files and applies writes/removes. */
export interface MirrorSink {
  manifest(): Promise<SyncManifest>;
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface ManifestDiff {
  /** Files present-and-changed or new in the source — pull these. */
  toWrite: string[];
  /** Files the sink has that the source no longer does — delete these. */
  toRemove: string[];
  /** Count of files identical on both sides. */
  unchanged: number;
}

export interface SyncResult {
  written: string[];
  removed: string[];
  unchanged: number;
}

export interface DurableWriteOps {
  rename?: (from: string, to: string) => Promise<void>;
}

/** Stable SHA-256 hex of a file's UTF-8 content — the unit of change detection. */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function fsyncDirectory(path: string): Promise<void> {
  const dir = await open(path, "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

/**
 * Crash-safe UTF-8 file replacement: write + fsync a temp file in the destination directory, atomically
 * rename it over the old file, then fsync the directory entry. Until rename succeeds, readers keep the
 * last committed file; after rename, a crash cannot expose a half-written JSON/blob.
 */
export async function writeFileDurably(
  path: string,
  content: string,
  ops: DurableWriteOps = {},
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(
    dir,
    `.${basename(path)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const handle = await open(tmp, "w");
  let closed = false;
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    closed = true;
    await (ops.rename ?? rename)(tmp, path);
    await fsyncDirectory(dir);
  } catch (err) {
    if (!closed) {
      try {
        await handle.close();
      } catch {
        // Preserve the original write/rename error.
      }
    }
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Diff a remote (cloud) manifest against a local one by content hash. Pure + deterministic. */
export function diffManifests(remote: SyncManifest, local: SyncManifest): ManifestDiff {
  const localByPath = new Map(local.files.map((f) => [f.path, f.hash]));
  const remotePaths = new Set(remote.files.map((f) => f.path));

  const toWrite: string[] = [];
  let unchanged = 0;
  for (const f of remote.files) {
    if (localByPath.get(f.path) === f.hash) unchanged += 1;
    else toWrite.push(f.path);
  }
  const toRemove = local.files.map((f) => f.path).filter((p) => !remotePaths.has(p));
  return { toWrite, toRemove, unchanged };
}

/** Apply the cloud manifest to the local sink: write changed/new files, remove deleted ones. */
export async function mirror(source: MirrorSource, sink: MirrorSink): Promise<SyncResult> {
  const [remote, local] = await Promise.all([source.manifest(), sink.manifest()]);
  const { toWrite, toRemove, unchanged } = diffManifests(remote, local);
  for (const path of toWrite) await sink.write(path, await source.read(path));
  for (const path of toRemove) await sink.remove(path);
  return { written: toWrite, removed: toRemove, unchanged };
}

/** Build a manifest from an in-memory {path: content} map (hashes computed like a real source). */
function manifestFromMap(files: Map<string, string>): SyncManifest {
  return {
    files: [...files.entries()].map(([path, content]) => ({
      path,
      hash: hashContent(content),
      size: Buffer.byteLength(content),
    })),
  };
}

/** In-memory cloud source for tests/demo — never touches a real cloud. */
export class InMemoryMirrorSource implements MirrorSource {
  private readonly files: Map<string, string>;
  constructor(files: Record<string, string>) {
    this.files = new Map(Object.entries(files));
  }
  manifest(): Promise<SyncManifest> {
    return Promise.resolve(manifestFromMap(this.files));
  }
  read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) return Promise.reject(new Error(`no such file: ${path}`));
    return Promise.resolve(content);
  }
}

/** In-memory local sink for tests — mirrors into a Map instead of disk. */
export class InMemoryMirrorSink implements MirrorSink {
  private readonly files: Map<string, string>;
  constructor(files: Record<string, string> = {}) {
    this.files = new Map(Object.entries(files));
  }
  manifest(): Promise<SyncManifest> {
    return Promise.resolve(manifestFromMap(this.files));
  }
  write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    return Promise.resolve();
  }
  remove(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }
  /** Current contents as a plain object (test assertion helper). */
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.files);
  }
}

/**
 * Local sink that mirrors a cloud workspace onto a real directory on disk. Every path is confined
 * to `root` — a manifest path that escapes (e.g. `../../etc/x`) is rejected, so a hostile source
 * can never write outside the mirror directory.
 */
export class FsMirrorSink implements MirrorSink {
  constructor(private readonly root: string) {}

  /** Resolve a relative path within the root, refusing any that escapes it. */
  private safeResolve(path: string): string {
    const full = resolve(this.root, path);
    const rel = relative(this.root, full);
    if (rel === "" || rel.startsWith("..") || rel.startsWith(`..${sep}`)) {
      throw new Error(`refusing to write path outside mirror root: ${path}`);
    }
    return full;
  }

  async manifest(): Promise<SyncManifest> {
    const files: SyncFile[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // root does not exist yet → empty manifest
      }
      for (const entry of entries) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs);
        } else if (entry.isFile()) {
          const content = await readFile(abs, "utf8");
          const rel = relative(this.root, abs).split(sep).join("/"); // POSIX paths in the manifest
          files.push({ path: rel, hash: hashContent(content), size: (await stat(abs)).size });
        }
      }
    };
    await walk(this.root);
    return { files };
  }

  async write(path: string, content: string): Promise<void> {
    const full = this.safeResolve(path);
    await writeFileDurably(full, content);
  }

  async remove(path: string): Promise<void> {
    const full = this.safeResolve(path);
    await rm(full, { force: true });
  }
}
