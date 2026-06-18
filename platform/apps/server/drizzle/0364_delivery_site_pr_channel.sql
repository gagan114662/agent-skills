-- 0364: one real marketing action — the site_pr delivery channel (#364, ADR-0364).
--
-- An approved SEO/content deliverable can now ship as a REAL on-site content PR against ipop's own site
-- repo (reversible, money-free, #13-gated) instead of only a standalone published page. Widen the
-- delivery_receipts channel CHECK to accept the new channel value. The column is plain `text` (no Postgres
-- enum type), so this is a single constraint swap — additive and reversible.
ALTER TABLE delivery_receipts DROP CONSTRAINT IF EXISTS delivery_receipts_channel_ck;
ALTER TABLE delivery_receipts
  ADD CONSTRAINT delivery_receipts_channel_ck CHECK (channel IN ('publish','site_pr','social','email'));
