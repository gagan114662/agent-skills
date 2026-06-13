-- Revert the Deliverable Verification Layer (#191, ADR-0191). Drops the two additive tables; nothing
-- else is touched.
DROP TABLE IF EXISTS verification_verdicts;
DROP TABLE IF EXISTS verification_criteria;
