-- Outbound-channel connect + receipt ledger (issue #395, ADR-0395 — revenue blocker #1: connect + enable
-- ONE real outbound channel). The fleet can today only touch its own site; to reach a stranger it needs
-- ONE connected, enabled sending channel with PROVEN delivery. Two additive, workspace-scoped tables:
--
--   outbound_channels       — the connect-once ledger (is the lowest-risk channel, Postmark email, connected
--                             for this workspace, by whom, from which sending identity). Holds NO secret:
--                             only a non-reversible credential FINGERPRINT (proof of connection). The live
--                             Postmark server token stays OWNER-GATED in the deployment env / #192 vault
--                             (manual owner step: `fly secrets set POSTMARK_SERVER_TOKEN=...`) and is read
--                             inline at the send site — never persisted here.
--   outbound_send_receipts  — append-only #200 §3 readback receipts: the production-grounded proof that a
--                             real send reached a real inbox (a Postmark MessageID read back, or a live-URL
--                             probe), tied to the #13 approval that authorized the send. `verified` is true
--                             only for a receipt that passes the `isExternalReceipt` predicate.
--
-- Numbered 0505 by a free prefix (per ADR-0099, to dodge sibling-workspace collisions in the shared
-- migration sequence). Tenant boundary: workspace_id (#3, ON DELETE CASCADE). The recipient + provider +
-- from_address + external_ref are treated as inbound/observed DATA, validated at the write site (#200 §6).
-- These tables complement, and do not duplicate, the #192 credential vault (which never returns secrets and
-- is not channel-typed). Hold NO secret and no money.
CREATE TABLE IF NOT EXISTS outbound_channels (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel text NOT NULL,                              -- email_postmark (see OUTBOUND_CHANNELS)
  provider text NOT NULL,                             -- postmark (mirrors the connection descriptor)
  status text NOT NULL DEFAULT 'pending',             -- pending | connected | revoked
  from_address text,                                  -- the verified DKIM-signed From address (NOT a secret)
  credential_fingerprint text,                        -- sha256 slice of the token (proof; never the token)
  connected_by_member_id uuid,                        -- the member who completed the owner consent
  connected_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS outbound_channels_workspace_channel_uk
  ON outbound_channels (workspace_id, channel);

CREATE TABLE IF NOT EXISTS outbound_send_receipts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel text NOT NULL,                              -- email_postmark
  approval_request_id uuid,                           -- the #13 request that authorized the send
  recipient text NOT NULL,                            -- the inbox we are proving we reached (observed DATA)
  source text NOT NULL,                               -- live_url | production_readback (#200 §3 allow-list)
  external_ref text NOT NULL,                         -- the ESP message id / live URL observed in production
  http_status integer,                               -- for live_url: the status a real probe returned
  verified boolean NOT NULL DEFAULT false,            -- passed isExternalReceipt (real, production-grounded)
  detail jsonb,                                        -- the probe response / read-back row (audit trail)
  observed_at timestamptz NOT NULL,                   -- when reality was observed (passed in by the caller)
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS outbound_send_receipts_workspace_idx
  ON outbound_send_receipts (workspace_id, created_at);
CREATE INDEX IF NOT EXISTS outbound_send_receipts_approval_idx
  ON outbound_send_receipts (approval_request_id);
