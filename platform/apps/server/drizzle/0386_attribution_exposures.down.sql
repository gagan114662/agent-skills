-- Down for #386 attributed-revenue ledger. Additive table; drop is safe (no other table references it).
DROP TABLE IF EXISTS attribution_exposures;
