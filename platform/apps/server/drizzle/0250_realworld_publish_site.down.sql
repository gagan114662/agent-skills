-- Revert #250: restore the #231 tool CHECK constraint without `publish_site`. (Any existing
-- publish_site rows would violate the old constraint, so delete them first — they are receipts, safe to drop.)
DELETE FROM realworld_artifacts WHERE tool = 'publish_site';
ALTER TABLE realworld_artifacts DROP CONSTRAINT IF EXISTS realworld_artifacts_tool_ck;
ALTER TABLE realworld_artifacts ADD CONSTRAINT realworld_artifacts_tool_ck
  CHECK (tool IN ('publish','send_email','post_social','browse','research','store_asset','call_api'));
