-- Down for 0151_ona_governance_trust (#151). Drop the three additive tables; nothing else referenced them.
DROP TABLE IF EXISTS egress_violations;
DROP TABLE IF EXISTS workspace_invites;
DROP TABLE IF EXISTS workspace_member_roles;
