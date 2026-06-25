ALTER TABLE outreach_messages
  DROP CONSTRAINT IF EXISTS outreach_messages_channel_ck;

ALTER TABLE outreach_messages
  ADD CONSTRAINT outreach_messages_channel_ck
  CHECK (channel IN ('email','linkedin','x','sms'));

ALTER TABLE realworld_artifacts
  DROP CONSTRAINT IF EXISTS realworld_artifacts_tool_ck;

ALTER TABLE realworld_artifacts
  ADD CONSTRAINT realworld_artifacts_tool_ck
  CHECK (tool IN ('publish','publish_site','send_email','send_sms','post_social','browse','research','store_asset','generate_image','call_api'));

ALTER TABLE external_setup_requests
  DROP CONSTRAINT IF EXISTS external_setup_requests_kind_ck;

ALTER TABLE external_setup_requests
  ADD CONSTRAINT external_setup_requests_kind_ck
  CHECK (service_kind IN ('esp','sms','ad_account','analytics','registrar','hosting','payment','other'));
