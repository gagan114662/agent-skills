-- Reverse 0119_evidence_priced_autonomy: drop the two append-only Evidence-Priced Autonomy tables.
DROP INDEX IF EXISTS gate_boundary_changes_workspace_created_idx;
DROP TABLE IF EXISTS gate_boundary_changes;
DROP INDEX IF EXISTS gate_evidence_action_created_idx;
DROP TABLE IF EXISTS gate_evidence;
