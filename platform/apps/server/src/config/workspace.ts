import { copyFileSync, mkdirSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { loadConfig } from "./loader.js";
import type { ResolvedConfig } from "./schema.js";

/**
 * Workspace provisioning seam (#58). On session launch the SessionManager (optionally) asks a
 * provisioner to prepare a working dir and copy the configured **files-to-copy** into it, then runs
 * the harness with that `cwd`. The seam is optional so existing #25 sessions are unchanged when no
 * provisioner is configured.
 */
export interface WorkspacePrepareInput {
  sessionId: string;
  workspaceId: string;
}

export interface PreparedWorkspace {
  /** The per-session working dir, passed to the runtime as `cwd` (undefined → inherit server cwd). */
  cwd?: string;
}

export interface WorkspaceProvisioner {
  prepare(input: WorkspacePrepareInput): Promise<PreparedWorkspace>;
}

export interface WorkspaceProvisionerDeps {
  /** Resolve the per-tenant config. Defaults to the real layered loader. */
  loadConfig?: (workspaceId: string) => ResolvedConfig;
  /** Base dir a relative `workspaceRoot`/source path resolves against. Defaults to `process.cwd()`. */
  baseDir?: string;
  /** Optional logger for skipped (missing) source files. */
  logger?: { warn(obj: unknown, msg?: string): void };
}

/**
 * The default provisioner: reads the tenant's resolved config, creates `workspaceRoot/<sessionId>`,
 * and copies each configured file into it. Copies are **best-effort and contained**:
 *   - a missing source file is skipped (logged), never fatal;
 *   - the destination is always the source **basename** inside the session dir, so a configured
 *     `../` or absolute source can never write outside the session workspace.
 */
export class FileConfigWorkspaceProvisioner implements WorkspaceProvisioner {
  private readonly load: (workspaceId: string) => ResolvedConfig;
  private readonly baseDir: string;
  private readonly logger?: { warn(obj: unknown, msg?: string): void };

  constructor(deps: WorkspaceProvisionerDeps = {}) {
    this.load = deps.loadConfig ?? ((workspaceId) => loadConfig(workspaceId));
    this.baseDir = deps.baseDir ?? process.cwd();
    this.logger = deps.logger;
  }

  prepare({ sessionId, workspaceId }: WorkspacePrepareInput): Promise<PreparedWorkspace> {
    const cfg = this.load(workspaceId);
    const root = isAbsolute(cfg.workspaceRoot) ? cfg.workspaceRoot : join(this.baseDir, cfg.workspaceRoot);
    const dir = join(root, sessionId);
    mkdirSync(dir, { recursive: true });

    for (const file of cfg.filesToCopy) {
      const src = isAbsolute(file) ? file : join(this.baseDir, file);
      const dest = join(dir, basename(file)); // basename → contained to the session dir
      try {
        copyFileSync(src, dest);
      } catch (err) {
        this.logger?.warn(
          { file, err: err instanceof Error ? err.message : String(err) },
          "files-to-copy: source unreadable, skipped",
        );
      }
    }

    return Promise.resolve({ cwd: dir });
  }
}
