-- Additive-only up ⇒ a clean reverse (drop indexes then tables; #222, ADR-0222).
DROP INDEX IF EXISTS discovery_pipeline_entries_stage_idx;
DROP TABLE IF EXISTS discovery_pipeline_entries;
DROP INDEX IF EXISTS discovery_pql_events_idea_idx;
DROP TABLE IF EXISTS discovery_pql_events;
DROP INDEX IF EXISTS discovery_signals_prospect_idx;
DROP INDEX IF EXISTS discovery_signals_idea_idx;
DROP TABLE IF EXISTS discovery_signals;
DROP TABLE IF EXISTS discovery_signal_defs;
