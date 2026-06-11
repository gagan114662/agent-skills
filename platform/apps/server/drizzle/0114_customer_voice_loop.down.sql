-- Down for 0114_customer_voice_loop (#114). Drop the two additive tables (child first); nothing else
-- referenced them.
DROP TABLE IF EXISTS voice_insights;
DROP TABLE IF EXISTS support_tickets;
