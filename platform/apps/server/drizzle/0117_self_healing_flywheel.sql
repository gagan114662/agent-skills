-- Self-Healing Flywheel (#117, ADR-0117): failure logs → deduped issues → fix agents.
-- Two workspace-scoped tables: (1) the deduped failure fingerprint; (2) the durable fix-dispatch ledger.

-- (1) Deduped failure fingerprint. unique(workspace_id, signature) makes "same failure twice = one
-- row" a database invariant. sample_context is REDACTED at ingest (#25) before it is written. The
-- single-open-issue anchor (issue_ref/issue_state/synced_occurrence_count) enforces the dedup contract;
-- the loop-closure fields (fix_session_id/fix_ref/fixed_at/excluded_from_auto_dispatch/escalated) carry
-- the #106 outcome verifier. Session ids are soft references (no FK) so the fingerprint outlives pruned
-- session history; only workspace_id carries the #3 tenant boundary.
CREATE TABLE IF NOT EXISTS failure_fingerprints (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  signature text NOT NULL,
  failure_class text NOT NULL,
  title text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  occurrence_count integer NOT NULL DEFAULT 1,
  sample_context text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  origin_channel_id uuid,
  origin_agent_member_id uuid,
  issue_ref text,
  issue_state text,
  synced_occurrence_count integer NOT NULL DEFAULT 0,
  fix_session_id uuid,
  fix_ref text,
  fixed_at timestamptz,
  excluded_from_auto_dispatch boolean NOT NULL DEFAULT false,
  escalated boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT failure_fingerprints_status_ck
    CHECK (status IN ('open','issued','fixing','fixed','recurred')),
  CONSTRAINT failure_fingerprints_signature_uk UNIQUE (workspace_id, signature)
);
CREATE INDEX IF NOT EXISTS failure_fingerprints_workspace_status_idx
  ON failure_fingerprints (workspace_id, status);

-- (2) Durable fix-dispatch ledger: every auto-launch / queued-approval, so the hard concurrent-fix cap
-- and the #104 console queue both read from one source of truth. fingerprint_id cascades so a deleted
-- workspace's dispatches go with it; session/approval ids are soft references.
CREATE TABLE IF NOT EXISTS flywheel_fix_dispatches (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  fingerprint_id uuid NOT NULL REFERENCES failure_fingerprints(id) ON DELETE CASCADE,
  mode text NOT NULL,
  status text NOT NULL,
  session_id uuid,
  approval_request_id uuid,
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flywheel_fix_dispatches_mode_ck CHECK (mode IN ('auto','queued')),
  CONSTRAINT flywheel_fix_dispatches_status_ck
    CHECK (status IN ('dispatched','queued','done','failed'))
);
CREATE INDEX IF NOT EXISTS flywheel_fix_dispatches_workspace_status_idx
  ON flywheel_fix_dispatches (workspace_id, status);
CREATE INDEX IF NOT EXISTS flywheel_fix_dispatches_fingerprint_idx
  ON flywheel_fix_dispatches (fingerprint_id);
