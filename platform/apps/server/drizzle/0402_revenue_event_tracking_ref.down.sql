-- Revert #386 slice-3 attribution tracking ref on revenue_events (ADR-0402).
ALTER TABLE revenue_events DROP COLUMN IF EXISTS tracking_ref;
