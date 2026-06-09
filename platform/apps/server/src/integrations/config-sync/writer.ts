import { dirname, join, normalize } from "node:path";
import type { SyncPlan } from "./exporters.js";

/** Injectable fs ops so the writer is unit-testable without touching disk. */
export interface SyncWriterDeps {
  /** Root the artifact paths are resolved under (a `~` prefix is expanded to this root). */
  root: string;
  writeFile: (path: string, content: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
}

/** Resolve an artifact's harness-relative path under the root, containing it (no `..` escape). */
function resolveUnderRoot(root: string, path: string): string {
  const rel = path.replace(/^~\//, "").replace(/^\//, "");
  const full = normalize(join(root, rel));
  if (full !== root && !full.startsWith(root + "/")) {
    throw new Error(`sync artifact path escapes root: ${path}`);
  }
  return full;
}

/**
 * Materialize a {@link SyncPlan} on disk (#57). Each artifact is written under the harness config
 * `root`; parent dirs are created first. Paths are contained to the root — a crafted `..` is rejected
 * rather than allowed to escape. fs ops are injected so tests stay hermetic.
 */
export async function applySyncPlan(plan: SyncPlan, deps: SyncWriterDeps): Promise<string[]> {
  const written: string[] = [];
  for (const artifact of plan.artifacts) {
    const full = resolveUnderRoot(deps.root, artifact.path);
    await deps.mkdir(dirname(full));
    await deps.writeFile(full, artifact.content);
    written.push(full);
  }
  return written;
}
