DROP INDEX IF EXISTS inbound_leads_workspace_status_idx;

ALTER TABLE inbound_leads
  DROP COLUMN IF EXISTS reach_contact_key,
  DROP COLUMN IF EXISTS sla_notified_at,
  DROP COLUMN IF EXISTS sla_due_at,
  DROP COLUMN IF EXISTS responded_at,
  DROP COLUMN IF EXISTS next_action,
  DROP COLUMN IF EXISTS assignee_member_id;
