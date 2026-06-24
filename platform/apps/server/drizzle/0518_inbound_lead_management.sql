ALTER TABLE inbound_leads
  ADD COLUMN IF NOT EXISTS assignee_member_id uuid,
  ADD COLUMN IF NOT EXISTS next_action text,
  ADD COLUMN IF NOT EXISTS responded_at timestamptz,
  ADD COLUMN IF NOT EXISTS sla_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS sla_notified_at timestamptz,
  ADD COLUMN IF NOT EXISTS reach_contact_key text;

CREATE INDEX IF NOT EXISTS inbound_leads_workspace_status_idx
  ON inbound_leads (workspace_id, status, created_at);

UPDATE inbound_leads
SET
  sla_due_at = COALESCE(sla_due_at, created_at + interval '24 hours'),
  reach_contact_key = COALESCE(reach_contact_key, 'email:' || lower(email))
WHERE sla_due_at IS NULL OR reach_contact_key IS NULL;
