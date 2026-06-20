-- Attribution slice 3 (#386, ADR-0402). Carry the #386 tracking ref through Stripe into `revenue_events`
-- so a real payment can be credited to the artifact/lead that drove it. Additive, nullable column: the
-- webhook copies `metadata.trackingRef` (sanitized — it arrives off an external webhook, #200 §6) onto the
-- row, and the attribution projection (attribution/service.ts) reads it instead of hard-coding null. Joining
-- exposure→receipt by this ref is the happened-before credit (L2; every credited dollar backed by an
-- external receipt, L1). Existing rows / no-ref payments keep tracking_ref NULL ⇒ still `unattributed`
-- (honest, never fabricated). Numbered 0402 by ISSUE-free FREE prefix (per ADR-0099 — 0400/0401 are claimed
-- on sibling workspaces in the shared migration sequence). Holds no secret and no money.
ALTER TABLE revenue_events ADD COLUMN IF NOT EXISTS tracking_ref text;
