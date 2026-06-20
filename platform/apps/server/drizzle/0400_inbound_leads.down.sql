-- Down for #GAP1 inbound lead capture (ADR-0400). Additive table; drop is safe (no other table references it).
DROP TABLE IF EXISTS inbound_leads;
