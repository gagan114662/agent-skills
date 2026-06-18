-- Revert 0364: narrow the delivery_receipts channel CHECK back to the original three channels.
-- Any `site_pr` receipts (only possible if the owner enabled #364) would violate the narrowed
-- constraint, so delete them first — a site_pr ship is reversible (a PR; nothing was merged).
DELETE FROM delivery_receipts WHERE channel = 'site_pr';
ALTER TABLE delivery_receipts DROP CONSTRAINT IF EXISTS delivery_receipts_channel_ck;
ALTER TABLE delivery_receipts
  ADD CONSTRAINT delivery_receipts_channel_ck CHECK (channel IN ('publish','social','email'));
