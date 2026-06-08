-- Revert 0013_approval_gates. Drops the three approval tables (children first). Issue #13.
DROP TABLE IF EXISTS approval_events;
DROP TABLE IF EXISTS approval_requests;
DROP TABLE IF EXISTS approval_policies;
