import type { FastifyInstance, FastifyReply } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import { requireMemoryCapability } from "../auth/access.js";
import { WorkspaceBackupService, BackupError } from "../backup/service.js";
import { createDefaultBackupService } from "../backup/default.js";
import { serializeEnvelope } from "../backup/archive.js";

export interface BackupRoutesOptions {
  /** Tests inject a service over in-memory seams; the default wires the self-managed Postgres store. */
  service?: WorkspaceBackupService;
}

/**
 * The workspace backup + export surface (issue #676). The READ endpoint returns the feature settings and
 * the workspace's existing backups. The MUTATIONS are: take a manual backup, produce a full one-click
 * export (the downloadable, restorable envelope), re-download a stored backup, and restore from an uploaded
 * export. Reads and benign backup/export require only workspace membership; **restore is destructive** and
 * therefore requires the workspace-administering (`propagate`) capability — an agent can never restore on
 * its own. Scheduled backups are taken out-of-band by the service's `runScheduledBackup` tick (the #559
 * scheduler seam); they are not exposed here.
 *
 * Caps-gated: when the feature is disabled (the default, owner-workspace-first) every endpoint answers
 * `409` — backups are opt-in via `WORKSPACE_BACKUP_ENABLED`. Tenant-scoped via the #19 guard (#3 IDOR).
 *
 * NOTE: registering this plugin in `app.ts` is intentionally left to a follow-up — wiring it now would edit
 * the shared app-assembly file and risk a parallel-merge conflict (the explicit #676 scoping constraint).
 */
export async function backupRoutes(app: FastifyInstance, opts: BackupRoutesOptions = {}): Promise<void> {
  const service = opts.service ?? createDefaultBackupService(app.log);

  /** 409 unless the feature is enabled for this deployment. */
  function gate(reply: FastifyReply): boolean {
    if (!service.enabled) {
      reply.code(409).send({ error: "workspace backup is not enabled" });
      return false;
    }
    return true;
  }

  /** Map a backup-domain rejection (invalid/foreign export) to 422 with its reason. */
  function fail(err: unknown, reply: FastifyReply): void {
    if (err instanceof BackupError) {
      reply.code(422).send({ error: err.message });
      return;
    }
    throw err;
  }

  app.get("/workspaces/:wid/backup", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    if (!gate(reply)) return;
    const backups = await service.listBackups(wid);
    return { enabled: true, settings: service.settings(), backups };
  });

  app.post("/workspaces/:wid/backup", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    if (!gate(reply)) return;
    const { record } = await service.createBackup(wid, "manual");
    reply.code(201);
    return { backup: record };
  });

  app.get("/workspaces/:wid/backup/export", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    if (!gate(reply)) return;
    const envelope = await service.exportWorkspace(wid);
    reply
      .header("content-type", "application/json")
      .header("content-disposition", `attachment; filename="workspace-${wid}-export.json"`)
      .send(serializeEnvelope(envelope));
  });

  app.get("/workspaces/:wid/backup/:bid", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, bid } = req.params as { wid: string; bid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    if (!gate(reply)) return;
    const envelope = await service.getBackupEnvelope(wid, bid);
    if (!envelope) {
      reply.code(404).send({ error: "backup not found" });
      return;
    }
    return { envelope };
  });

  app.post("/workspaces/:wid/backup/restore", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    // Restore overwrites workspace data — admin-only (#13/#200): an agent can never restore on its own.
    if (!(await requireMemoryCapability(id, wid, "propagate", reply))) return;
    if (!gate(reply)) return;
    const { envelope } = (req.body ?? {}) as { envelope?: unknown };
    try {
      const result = await service.restoreWorkspace(wid, envelope);
      return result;
    } catch (err) {
      return fail(err, reply);
    }
  });
}
