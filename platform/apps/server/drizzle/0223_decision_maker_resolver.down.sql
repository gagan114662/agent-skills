-- Revert #223 decision-maker resolver.
DROP INDEX IF EXISTS buyer_briefs_workspace_account_idx;
DROP INDEX IF EXISTS buyer_briefs_workspace_idx;
DROP TABLE IF EXISTS buyer_briefs;
