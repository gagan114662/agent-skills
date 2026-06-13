-- Down-migration for 0194 (Finance Ledger, #194). Drop indexes then tables (reverse of up).
DROP INDEX IF EXISTS finance_close_packs_scope_uk;
DROP INDEX IF EXISTS finance_close_packs_workspace_idx;
DROP TABLE IF EXISTS finance_close_packs;

DROP INDEX IF EXISTS finance_ledger_venture_idx;
DROP INDEX IF EXISTS finance_ledger_workspace_idx;
DROP TABLE IF EXISTS finance_ledger_entries;
