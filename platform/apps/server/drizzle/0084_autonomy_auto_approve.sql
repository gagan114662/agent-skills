-- 0084_autonomy_auto_approve — auto-approve policy rule for autonomous completion (ADR-0042 follow-up).
-- Adds the audit columns on the autonomy approval gate so a policy-driven auto-approval is
-- distinguishable from a human one and records WHICH rule fired. Default 'human' keeps every existing
-- row + the no-rule path unchanged (the human gate). `policy_rule_id` references the #13
-- approval_policies rule (audit anchor); ON DELETE SET NULL so deleting the rule never loses the gate
-- record, only the rule pointer. Additive + nullable — no existing behaviour changes.

ALTER TABLE agent_approvals
  ADD COLUMN decision_source text NOT NULL DEFAULT 'human',
  ADD COLUMN policy_rule_id  uuid REFERENCES approval_policies(id) ON DELETE SET NULL;

ALTER TABLE agent_approvals
  ADD CONSTRAINT agent_approvals_decision_source_ck
    CHECK (decision_source IN ('human', 'policy'));
