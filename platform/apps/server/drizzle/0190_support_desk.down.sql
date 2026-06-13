-- Down for 0190_support_desk (#190). Drop the two additive tables; nothing else referenced them.
-- The #190 `customer_complaint` flywheel class is a plain text column value (not a pg enum), so there is
-- nothing schema-level to revert there.
DROP TABLE IF EXISTS support_receipts;
DROP TABLE IF EXISTS support_kb_entries;
