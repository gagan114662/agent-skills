-- Reverse of 0084_autonomy_auto_approve.
ALTER TABLE agent_approvals DROP CONSTRAINT IF EXISTS agent_approvals_decision_source_ck;
ALTER TABLE agent_approvals DROP COLUMN IF EXISTS policy_rule_id;
ALTER TABLE agent_approvals DROP COLUMN IF EXISTS decision_source;
