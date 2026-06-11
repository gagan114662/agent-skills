-- Revert Outcome Verifiers (#106, ADR-0106). Drops the single additive table; nothing else is touched.
DROP TABLE IF EXISTS verifier_results;
