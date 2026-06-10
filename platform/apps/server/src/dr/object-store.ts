/**
 * Vendor-independent object storage seam for off-site dumps (#99, ADR-0099).
 *
 * The interface is the contract the validation drill depends on. The default implementation is
 * {@link LocalDirObjectStore} (a filesystem directory) — no cloud spend, used by tests, the drill,
 * and the honest local/compose fallback. The REAL off-site upload is done by the backup GitHub
 * Actions job with the `aws` CLI against an S3-compatible, endpoint-configurable bucket (Cloudflare
 * R2 / Backblaze B2 / MinIO / AWS S3) — vendor independence comes from the S3 protocol, not a baked-in
 * SDK. ADR-0099 §4.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, copyFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";

export interface StoredObject {
  /** The object key (path under the store root). */
  key: string;
  /** Size in bytes. */
  bytes: number;
  /** Last-modified epoch millis — used to pick "the latest" dump. */
  modifiedMs: number;
}

export interface ObjectStore {
  /** Upload a local file to `key`. */
  put(key: string, filePath: string): Promise<StoredObject>;
  /** List objects under `prefix`, newest first. */
  list(prefix: string): Promise<StoredObject[]>;
  /** The most recently modified object under `prefix`, or null if none. */
  getLatest(prefix: string): Promise<StoredObject | null>;
  /** Download `key` to a local file path. */
  download(key: string, destPath: string): Promise<void>;
}

/** Filesystem-backed object store: the dryrun-by-default backend + local/compose fallback. */
export class LocalDirObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  private abs(key: string): string {
    return join(this.root, key);
  }

  async put(key: string, filePath: string): Promise<StoredObject> {
    const dest = this.abs(key);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(filePath, dest);
    const s = await stat(dest);
    return { key, bytes: s.size, modifiedMs: s.mtimeMs };
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const dir = this.abs(prefix);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const objects: StoredObject[] = [];
    for (const name of names) {
      const full = join(dir, name);
      const s = await stat(full).catch(() => null);
      if (s?.isFile()) {
        objects.push({ key: join(prefix, name), bytes: s.size, modifiedMs: s.mtimeMs });
      }
    }
    return objects.sort((a, b) => b.modifiedMs - a.modifiedMs);
  }

  async getLatest(prefix: string): Promise<StoredObject | null> {
    return (await this.list(prefix))[0] ?? null;
  }

  async download(key: string, destPath: string): Promise<void> {
    await mkdir(dirname(destPath), { recursive: true });
    // Stream-copy so a large dump never buffers fully in memory.
    await pipeline(createReadStream(this.abs(key)), createWriteStream(destPath));
  }
}
