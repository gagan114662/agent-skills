-- Down migration for 0100_insight_miner (#100). Drop in FK order (evidence → insights → sources).
DROP TABLE IF EXISTS insight_evidence;
DROP TABLE IF EXISTS insights;
DROP TABLE IF EXISTS insight_sources;
