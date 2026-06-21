-- Revert 0503_agent_decisions. The table is self-contained (only inbound FKs from itself); dropping it
-- removes its indexes + constraints with it. Nothing else references agent_decisions, so this is clean.
DROP TABLE IF EXISTS agent_decisions;
