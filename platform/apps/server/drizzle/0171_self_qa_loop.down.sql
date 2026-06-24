-- Restore the #148 paging constraints to their pre-#171 (narrower) form.
-- Rows emitted by the self-QA loop use the widened #171 values and would violate the
-- restored #148 CHECKs, so remove them before narrowing the constraints.
DELETE FROM reliability_pages WHERE source = 'selfqa' OR kind = 'selfqa_critical';
ALTER TABLE reliability_pages DROP CONSTRAINT IF EXISTS reliability_pages_source_ck;
ALTER TABLE reliability_pages ADD CONSTRAINT reliability_pages_source_ck
  CHECK (source IN ('sre','uptime'));
ALTER TABLE reliability_pages DROP CONSTRAINT IF EXISTS reliability_pages_kind_ck;
ALTER TABLE reliability_pages ADD CONSTRAINT reliability_pages_kind_ck
  CHECK (kind IN ('opened','repaged','resolved','uptime_down','uptime_recover'));

DROP TABLE IF EXISTS selfqa_runs;
