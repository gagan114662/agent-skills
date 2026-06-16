-- Revert #271 brand kit + asset store.
DELETE FROM realworld_artifacts WHERE tool = 'generate_image';
ALTER TABLE realworld_artifacts DROP CONSTRAINT IF EXISTS realworld_artifacts_tool_ck;
ALTER TABLE realworld_artifacts ADD CONSTRAINT realworld_artifacts_tool_ck
  CHECK (tool IN ('publish','publish_site','send_email','post_social','browse','research','store_asset','call_api'));

DROP INDEX IF EXISTS workspace_assets_draft_idx;
DROP INDEX IF EXISTS workspace_assets_workspace_created_idx;
DROP TABLE IF EXISTS workspace_assets;

DROP INDEX IF EXISTS brand_kits_one_active_idx;
DROP INDEX IF EXISTS brand_kits_workspace_idx;
DROP TABLE IF EXISTS brand_kits;
