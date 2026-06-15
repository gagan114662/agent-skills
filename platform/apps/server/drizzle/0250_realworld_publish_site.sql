-- Self-publish to ipop.ai (#250): the fleet can now open a PR against ipop's own site repo via the
-- AUTONOMOUS `publish_site` tool (money-free + reversible ⇒ no #13 gate). Its receipts land in the same
-- realworld_artifacts trail, so the tool CHECK constraint must admit the new value. Numbered 0250 by
-- ISSUE (per ADR-0099) to dodge sibling-workspace collisions in the shared migration sequence.

ALTER TABLE realworld_artifacts DROP CONSTRAINT IF EXISTS realworld_artifacts_tool_ck;
ALTER TABLE realworld_artifacts ADD CONSTRAINT realworld_artifacts_tool_ck
  CHECK (tool IN ('publish','publish_site','send_email','post_social','browse','research','store_asset','call_api'));
