-- Down for 0170_slack_native (#170). Drop the additive Slack tables in reverse dependency order;
-- nothing else referenced them.
DROP TABLE IF EXISTS slack_events_seen;
DROP TABLE IF EXISTS slack_thread_links;
DROP TABLE IF EXISTS slack_user_links;
DROP TABLE IF EXISTS slack_channel_links;
DROP TABLE IF EXISTS workspace_slack_connections;
