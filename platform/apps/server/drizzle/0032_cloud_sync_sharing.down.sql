-- Revert 0032_cloud_sync_sharing (issue #55). Drop collaborators first (FK → cloud_workspaces).
DROP TABLE IF EXISTS cloud_workspace_collaborators;
DROP TABLE IF EXISTS cloud_workspaces;
