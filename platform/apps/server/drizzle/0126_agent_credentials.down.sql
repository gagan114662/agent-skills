-- Down for 0126_agent_credentials (#68). Drop the additive vault table; nothing else referenced it.
DROP TABLE IF EXISTS workspace_agent_credentials;
