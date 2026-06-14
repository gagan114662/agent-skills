-- Down-migration for #187 (ADR-0187). Drops the three venture-factory tables in FK order
-- (ventures + validations reference candidates).
DROP TABLE IF EXISTS factory_ventures;
DROP TABLE IF EXISTS factory_validations;
DROP TABLE IF EXISTS factory_candidates;
