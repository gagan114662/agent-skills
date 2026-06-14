-- Outreach engine (#225, ADR-0225): signal-triggered, owner-gated, externally-measured outreach. Two
-- workspace-scoped tables. Numbered 0225 by ISSUE (per ADR-0099, to dodge sibling-workspace collisions
-- in the shared migration sequence). Tenant boundary: workspace_id (#3, ON DELETE CASCADE).
--
-- `outreach_messages` — one row per composed, owner-gated message attempt (audit + experiment
-- denominator). A message is inert until the owner approves the matching #13 request; the recipient is an
-- OPAQUE ref (`<channel>:<contactId>`), never raw PII. idea_id / account_id / buyer_brief_id are SOFT
-- refs (no FK). `outreach_receipts` — EXTERNAL receipts ONLY (reply/meeting/signup), each with a
-- non-empty external_ref (the proof); the only source of experiment + GTM-pipeline truth (premortem
-- #200 §2). Names are deliberately NOT venture_/growth_-prefixed so the #155 colocation gate does not
-- class them as governed metric surfaces.

CREATE TABLE IF NOT EXISTS outreach_messages (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idea_id uuid,                                    -- NULL = workspace-level (soft ref to #96)
  prospect_key text NOT NULL,                      -- opaque #222 actor token (no PII)
  account_id text,                                 -- soft ref to the #223 account
  buyer_brief_id uuid,                             -- soft ref to the #223 brief this was composed from
  channel text NOT NULL,                           -- email | linkedin | x
  variant text NOT NULL,                           -- time_saved | productivity | cost (value-prop A/B/C)
  signal_kind text,                                -- the PQL signal kind that triggered the channel choice
  subject text NOT NULL DEFAULT '',                -- email subject ('' for social channels)
  body text NOT NULL,                              -- the composed, problem-led message
  recipient_label text NOT NULL DEFAULT '',        -- human label for the approval card (no PII)
  recipient_ref text NOT NULL,                     -- opaque target ref (<channel>:<contactId>)
  experiment_key text NOT NULL,                    -- groups variants into one experiment (idea + channel)
  status text NOT NULL,                            -- drafted | blocked | pending_approval | sent | failed
  approval_request_id uuid,                        -- soft ref to the #13 approval that gates the send
  provider text NOT NULL DEFAULT 'dryrun',         -- dryrun | <esp/social provider> ...
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outreach_messages_channel_ck CHECK (channel IN ('email','linkedin','x')),
  CONSTRAINT outreach_messages_variant_ck CHECK (variant IN ('time_saved','productivity','cost')),
  CONSTRAINT outreach_messages_status_ck
    CHECK (status IN ('drafted','blocked','pending_approval','sent','failed'))
);

CREATE INDEX IF NOT EXISTS outreach_messages_workspace_created_idx
  ON outreach_messages (workspace_id, created_at);
CREATE INDEX IF NOT EXISTS outreach_messages_experiment_idx
  ON outreach_messages (workspace_id, experiment_key);

CREATE TABLE IF NOT EXISTS outreach_receipts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES outreach_messages(id) ON DELETE CASCADE,
  kind text NOT NULL,                              -- reply | meeting | signup (all EXTERNAL receipts)
  external_ref text NOT NULL,                      -- the proof it is external (provider/event id) — non-empty
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outreach_receipts_kind_ck CHECK (kind IN ('reply','meeting','signup'))
);

CREATE INDEX IF NOT EXISTS outreach_receipts_workspace_idx
  ON outreach_receipts (workspace_id, created_at);
CREATE INDEX IF NOT EXISTS outreach_receipts_message_idx
  ON outreach_receipts (message_id);
-- Idempotency: a re-delivered external receipt (webhook retry) lands exactly once.
CREATE UNIQUE INDEX IF NOT EXISTS outreach_receipts_unique
  ON outreach_receipts (workspace_id, message_id, kind, external_ref);
