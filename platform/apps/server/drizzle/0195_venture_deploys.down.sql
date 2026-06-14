-- Down-migration for #195 (ADR-0195). Drops the venture-deploy tables (per-venture targets + immutable
-- release receipts). Additive-only up ⇒ a clean reverse.
DROP INDEX IF EXISTS deploy_releases_workspace_idx;
DROP INDEX IF EXISTS deploy_releases_venture_idx;
DROP TABLE IF EXISTS deploy_releases;
DROP INDEX IF EXISTS deploy_targets_workspace_idx;
DROP TABLE IF EXISTS deploy_targets;
