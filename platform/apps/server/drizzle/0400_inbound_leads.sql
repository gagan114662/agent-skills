-- Inbound lead capture (GAP 1 of the leads centre, ADR-0400). One additive, workspace-scoped table: the
-- autonomous loop's INBOUND mouth. The public landing "what are you hoping the fleet can do?" form was
-- client-only and dropped every lead; it now POSTs to /inbound/leads which persists a row here and (best
-- effort) feeds it to the #222 discovery engine as a `role_identified` signal. Numbered 0400 by a free
-- prefix (per ADR-0099, to dodge sibling-workspace collisions in the shared migration sequence). Tenant
-- boundary: workspace_id (#3, ON DELETE CASCADE). Every free-text field is UNTRUSTED inbound DATA,
-- sanitized + length-capped at the write site (#200 §6). The name is deliberately NOT
-- tenant_usage*/venture_/growth_/demand_/moat_-prefixed so the #155 colocation gate does not class it as a
-- governed metric surface (it is a CRM intake row, not a metric). Holds NO secret and no money.
CREATE TABLE IF NOT EXISTS inbound_leads (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text,                                        -- the prospect's name (untrusted, sanitized at write)
  email text NOT NULL,                              -- the prospect's email (validated shape, sanitized)
  message text NOT NULL,                            -- "what are you hoping the fleet can do?" (untrusted)
  source text NOT NULL DEFAULT 'landing_form',      -- the surface the lead arrived on (structural label)
  tracking_ref text,                                -- reserved for #386 attribution (recovered ?ref=)
  status text NOT NULL DEFAULT 'new',               -- new | working | converted | archived
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inbound_leads_workspace_idx ON inbound_leads (workspace_id, created_at);
