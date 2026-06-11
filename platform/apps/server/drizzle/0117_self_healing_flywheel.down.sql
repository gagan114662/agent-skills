-- Rollback Self-Healing Flywheel (#117).
DROP TABLE IF EXISTS flywheel_fix_dispatches;
DROP TABLE IF EXISTS failure_fingerprints;
