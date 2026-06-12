-- Restore the #148 paging constraints to their pre-#171 (narrower) form.
ALTER TABLE reliability_pages DROP CONSTRAINT IF EXISTS reliability_pages_source_ck;
ALTER TABLE reliability_pages ADD CONSTRAINT reliability_pages_source_ck
  CHECK (source IN ('sre','uptime'));
ALTER TABLE reliability_pages DROP CONSTRAINT IF EXISTS reliability_pages_kind_ck;
ALTER TABLE reliability_pages ADD CONSTRAINT reliability_pages_kind_ck
  CHECK (kind IN ('opened','repaged','resolved','uptime_down','uptime_recover'));

DROP TABLE IF EXISTS selfqa_runs;
