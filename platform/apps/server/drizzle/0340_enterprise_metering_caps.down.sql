-- Revert #340 (ADR-0340): drop the enterprise metering ledger + budget caps tables and their indexes.
DROP INDEX IF EXISTS enterprise_usage_agent_idx;
DROP INDEX IF EXISTS enterprise_usage_workspace_idx;
DROP TABLE IF EXISTS enterprise_budget_caps;
DROP TABLE IF EXISTS enterprise_usage;
