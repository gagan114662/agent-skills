-- Down for SkillOpt-Sleep run persistence (#283, ADR-0283). Additive tables; drop is safe — nothing else
-- references them, and they hold only an audit ledger (no money, no secret). Drop the child first.
DROP TABLE IF EXISTS skillopt_proposals;
DROP TABLE IF EXISTS skillopt_runs;
