/**
 * Workspace backup/export config (issue #676). Deliberately **self-contained**: the master switch, the
 * scheduled-backup interval, and the retention count are read directly from the process environment, so
 * this feature adds NO edits to the shared `config/schema.ts` barrel — keeping the #676 change set free of
 * parallel-merge conflicts with sibling branches (same pattern as the #670 spend-cap governor).
 *
 * Default **OFF**, owner-workspace-first (the universal convention): a deployment that sets nothing runs no
 * scheduled backups and the backup/export/restore routes answer 409.
 */

/** Defaults applied when the corresponding env var is unset or invalid. */
export const BACKUP_DEFAULTS = {
  enabled: false,
  /** How often a scheduled backup is taken, in hours. */
  intervalHours: 24,
  /** How many backups to retain per workspace; older ones are pruned. */
  retention: 7,
} as const;

export interface WorkspaceBackupCaps {
  /** Master switch for scheduled backups + the backup/export/restore routes. OFF by default. */
  enabled: boolean;
  /** Scheduled-backup cadence in hours (>= 1). */
  intervalHours: number;
  /** Number of backups kept per workspace (>= 1). */
  retention: number;
}

/** Parse a boolean-ish env flag: `1`/`true`/`yes`/`on` (case-insensitive) ⇒ true; everything else ⇒ false. */
function envFlag(raw: string | undefined): boolean {
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** Parse a positive integer env value with a floor of 1; a missing/invalid value keeps the default. */
function envPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.trunc(n));
}

/** Resolve the backup caps from the environment (defaults applied). Pure given its `env` argument. */
export function resolveWorkspaceBackupCaps(env: NodeJS.ProcessEnv = process.env): WorkspaceBackupCaps {
  return {
    enabled: envFlag(env.WORKSPACE_BACKUP_ENABLED),
    intervalHours: envPositiveInt(env.WORKSPACE_BACKUP_INTERVAL_HOURS, BACKUP_DEFAULTS.intervalHours),
    retention: envPositiveInt(env.WORKSPACE_BACKUP_RETENTION, BACKUP_DEFAULTS.retention),
  };
}
