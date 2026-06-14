-- Down-migration for #197 (ADR-0197). Drops the three venture-memory/planning tables. Venture memory
-- itself lives in the #15 `memories` table and is NOT touched here (those rows are owned by #15).
DROP TABLE IF EXISTS venture_playbooks;
DROP TABLE IF EXISTS venture_plans;
DROP TABLE IF EXISTS venture_okrs;
