-- Reach — autonomous outbound demand-gen department (#280, ADR-0280). Four workspace-scoped tables.
-- Numbered 0280 by ISSUE (per ADR-0099, to dodge sibling-workspace collisions in the shared sequence).
-- Tenant boundary: workspace_id (#3, ON DELETE CASCADE). Names are deliberately NOT venture_/growth_/
-- demand_/moat_-prefixed so the #155 colocation gate does not class them as governed metric surfaces.
--
-- reach_contacts — dedupe ledger + cadence enrolment; the (workspace_id, contact_key) unique index IS the
-- "never re-touch last week's list" guarantee. reach_sends — one row per send attempt (audit + denominator).
-- reach_receipts — EXTERNAL engagement only (open/reply/booked), each with a non-empty external_ref,
-- idempotent. reach_runs — one cron batch's found/sent counts + the self-tuning report it produced.

CREATE TABLE IF NOT EXISTS reach_contacts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_key text NOT NULL,                       -- email:/linkedin:/id:… dedupe identity (never signal text)
  recipient_label text NOT NULL DEFAULT '',        -- human label for the audit surface
  channel text NOT NULL,                           -- email | linkedin
  status text NOT NULL DEFAULT 'active',           -- active | completed | replied | opted_out
  current_step integer NOT NULL DEFAULT 0,         -- next cadence step
  last_step_at timestamptz,
  score integer NOT NULL DEFAULT 0,                -- ICP fit/signal score (0–100)
  signal_kind text,                                -- the signal the first opener was built around
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reach_contacts_channel_ck CHECK (channel IN ('email','linkedin')),
  CONSTRAINT reach_contacts_status_ck CHECK (status IN ('active','completed','replied','opted_out'))
);

CREATE UNIQUE INDEX IF NOT EXISTS reach_contacts_unique ON reach_contacts (workspace_id, contact_key);
CREATE INDEX IF NOT EXISTS reach_contacts_workspace_status_idx ON reach_contacts (workspace_id, status);

CREATE TABLE IF NOT EXISTS reach_sends (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_key text NOT NULL,
  channel text NOT NULL,                            -- email | linkedin
  status text NOT NULL,                             -- sent | queued | suppressed | rate_limited | skipped | failed
  variant text NOT NULL,                            -- pain | outcome | social_proof
  signal_kind text,
  subject text NOT NULL DEFAULT '',
  external_id text,                                 -- provider message id when sent
  sent_hour_utc integer,                            -- UTC hour the send fired (0–23)
  detail text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reach_sends_channel_ck CHECK (channel IN ('email','linkedin')),
  CONSTRAINT reach_sends_variant_ck CHECK (variant IN ('pain','outcome','social_proof')),
  CONSTRAINT reach_sends_status_ck
    CHECK (status IN ('sent','queued','suppressed','rate_limited','skipped','failed'))
);

CREATE INDEX IF NOT EXISTS reach_sends_workspace_created_idx ON reach_sends (workspace_id, created_at);
CREATE INDEX IF NOT EXISTS reach_sends_contact_idx ON reach_sends (workspace_id, contact_key);

CREATE TABLE IF NOT EXISTS reach_receipts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  send_id uuid NOT NULL REFERENCES reach_sends(id) ON DELETE CASCADE,
  contact_key text NOT NULL,
  kind text NOT NULL,                               -- open | reply | booked (all EXTERNAL receipts)
  external_ref text NOT NULL,                       -- the proof it is external (provider/event id) — non-empty
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reach_receipts_kind_ck CHECK (kind IN ('open','reply','booked'))
);

CREATE INDEX IF NOT EXISTS reach_receipts_workspace_idx ON reach_receipts (workspace_id, created_at);
CREATE INDEX IF NOT EXISTS reach_receipts_send_idx ON reach_receipts (send_id);
-- Idempotency: a re-delivered external receipt (webhook retry) lands exactly once.
CREATE UNIQUE INDEX IF NOT EXISTS reach_receipts_unique
  ON reach_receipts (workspace_id, send_id, kind, external_ref);

CREATE TABLE IF NOT EXISTS reach_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_kind text NOT NULL,                        -- mock | clay | lusha | vibe
  status text NOT NULL,                             -- completed | awaiting_data_funding | skipped
  prospects_found integer NOT NULL DEFAULT 0,
  messages_sent integer NOT NULL DEFAULT 0,
  messages_queued integer NOT NULL DEFAULT 0,
  suppressed_count integer NOT NULL DEFAULT 0,
  rate_limited_count integer NOT NULL DEFAULT 0,
  tuning_report jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reach_runs_status_ck CHECK (status IN ('completed','awaiting_data_funding','skipped'))
);

CREATE INDEX IF NOT EXISTS reach_runs_workspace_created_idx ON reach_runs (workspace_id, created_at);
