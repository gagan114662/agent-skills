-- Rollback YC Startup Constitution enforcement (#146).
DROP TABLE IF EXISTS constitution_violations;
ALTER TABLE venture_ideas DROP CONSTRAINT IF EXISTS venture_ideas_segment_ck;
ALTER TABLE venture_ideas DROP COLUMN IF EXISTS segment;
