-- Revert 0506_agent_trace. Drop the event log first (it FKs the run header), then the header. Both are
-- self-contained — only inbound FKs are from agent_trace_events to agent_trace_runs — so this is clean.
-- Dropping each table removes its indexes + constraints with it. Nothing else references either table.
DROP TABLE IF EXISTS agent_trace_events;
DROP TABLE IF EXISTS agent_trace_runs;
