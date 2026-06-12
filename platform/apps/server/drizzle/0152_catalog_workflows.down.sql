-- Down for 0152_catalog_workflows (#152). Drop the run ledger first (FK to workflows), then the two
-- definition tables. Nothing else referenced these additive tables.
DROP TABLE IF EXISTS workflow_runs;
DROP TABLE IF EXISTS workflows;
DROP TABLE IF EXISTS catalog_entries;
