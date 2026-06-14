-- Acquisition execution (#189, ADR-0189): the fleet runs real campaigns, not plans. Numbered 0189 by
-- ISSUE (per ADR-0099, to dodge sibling-workspace collisions in the shared migration sequence). Tenant
-- boundary throughout: workspace_id (#3 IDOR discipline). Table names are deliberately `acquisition_*`
-- (not `growth_*`/`venture_*`) so the #155 metric-surface colocation check is not tripped.
--
-- THREE additive tables, no authority over any existing business-domain table:
--   1. acquisition_budget_envelopes — the owner-approved ad budget envelope (AC1, the money decision).
--   2. acquisition_send_receipts    — external-grounded receipts of every real channel send (AC1–AC5).
--   3. acquisition_suppressions     — the email suppression list, enforced in code on every send (AC2).

-- 1. The owner-approved ad budget envelope (AC1). The owner approves a cap ONCE; bid optimizations then
--    spend autonomously against it until spent_cents reaches cap_cents or the status leaves 'active'.
--    Spending over the envelope is never autonomous (the dispatcher refuses + the owner re-approves).
CREATE TABLE IF NOT EXISTS acquisition_budget_envelopes (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idea_id uuid,                                    -- soft ref (no FK); null = workspace-level
  channel text NOT NULL DEFAULT 'ads',             -- ads | email | social | seo
  period_key text NOT NULL,                        -- budget period label, part of the dedupe key
  cap_cents integer NOT NULL,                      -- the owner-approved ceiling (the money decision)
  spent_cents integer NOT NULL DEFAULT 0,          -- cumulative real spend debited by the dispatcher
  status text NOT NULL DEFAULT 'pending',          -- pending | active | exhausted | paused | revoked
  -- The #13 approval that authorized this envelope. Soft (no FK) so the acquisition layer never gains
  -- authority over the approvals table and a swept/expired approval can't cascade-delete an envelope.
  approval_request_id uuid,
  approved_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT acquisition_budget_envelopes_channel_ck
    CHECK (channel IN ('ads','email','social','seo')),
  CONSTRAINT acquisition_budget_envelopes_status_ck
    CHECK (status IN ('pending','active','exhausted','paused','revoked')),
  -- One envelope per (workspace, idea, channel, period): re-filing upserts rather than stacking.
  CONSTRAINT acquisition_budget_envelopes_period_uk UNIQUE (workspace_id, idea_id, channel, period_key)
);
CREATE INDEX IF NOT EXISTS acquisition_budget_envelopes_workspace_status_idx
  ON acquisition_budget_envelopes (workspace_id, status);

-- 2. The external-grounded send receipts (AC1–AC5). external_id is the provider's OWN message/campaign
--    id; status is what the provider reported. CAC + daily-spend the founder brief reads come from these
--    rows, never a self-reported number (premortem #200 §2/§3). provider='dryrun' rows are recorded-only.
CREATE TABLE IF NOT EXISTS acquisition_send_receipts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idea_id uuid,                                    -- soft ref (no FK); the venture this is attributed to
  channel text NOT NULL,                           -- ads | email | social | seo
  kind text NOT NULL,                              -- ad.spend | email.send | social.post | content.publish
  provider text NOT NULL,                          -- dryrun | google | postmark | x | ...
  status text NOT NULL,                            -- sent | failed | suppressed
  external_id text,                                -- the provider's external receipt id (null on failure)
  amount_cents integer,                            -- real ad spend in cents (null for non-ad sends)
  recipient_count integer NOT NULL DEFAULT 0,      -- emails actually sent (after suppression + warmup)
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT acquisition_send_receipts_channel_ck
    CHECK (channel IN ('ads','email','social','seo')),
  CONSTRAINT acquisition_send_receipts_status_ck
    CHECK (status IN ('sent','failed','suppressed'))
);
CREATE INDEX IF NOT EXISTS acquisition_send_receipts_workspace_created_idx
  ON acquisition_send_receipts (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS acquisition_send_receipts_workspace_channel_idx
  ON acquisition_send_receipts (workspace_id, channel, created_at DESC);

-- 3. The email suppression list (AC2). Anyone who bounced, complained, or unsubscribed is a hard block
--    consulted in code on every send. Fed by ESP bounce/complaint webhooks + explicit unsubscribes.
--    Deliverability is irreversible (premortem #200 §4) — this list is the law, not a courtesy.
CREATE TABLE IF NOT EXISTS acquisition_suppressions (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  recipient text NOT NULL,                         -- normalized (trim + lowercase) email
  reason text NOT NULL,                            -- bounce | complaint | unsubscribe | manual
  source text NOT NULL DEFAULT 'manual',           -- the ESP event type, 'manual', etc.
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT acquisition_suppressions_reason_ck
    CHECK (reason IN ('bounce','complaint','unsubscribe','manual')),
  -- One suppression per (workspace, recipient): re-suppression upserts, never stacks.
  CONSTRAINT acquisition_suppressions_recipient_uk UNIQUE (workspace_id, recipient)
);
CREATE INDEX IF NOT EXISTS acquisition_suppressions_workspace_idx
  ON acquisition_suppressions (workspace_id, created_at DESC);
