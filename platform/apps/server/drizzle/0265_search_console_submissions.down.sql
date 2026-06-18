-- Revert #265 Search Console auto-submit receipts.
DROP INDEX IF EXISTS search_console_submissions_workspace_created_idx;
DROP TABLE IF EXISTS search_console_submissions;
