-- Reliability surface (#148, ADR-0148): owner paging, chat-native incidents, AI investigation.
-- Two workspace-scoped tables, ADDITIVE — sre_incidents (#112) is untouched, so this slice does not
-- ripple into the SRE repo/types/tests.
--
--  * reliability_incidents — the one-per-incident overlay: the #incident-NNN war-room channel, the
--    per-workspace sequence, the AI investigation note, and the paging state (last page / ack / count).
--  * reliability_pages — the page audit + rate-limit window source: who was paged, why, and whether it
--    was delivered or suppressed. uptime pages have no incident (incident_id NULL).
--
-- incident_id is a SOFT reference (no FK) so the overlay outlives pruned incident history; only
-- workspace_id carries the #3 tenant boundary. Number-by-ISSUE (0148) to dodge sibling-branch prefix
-- collisions in the shared sequence.

CREATE TABLE IF NOT EXISTS reliability_incidents (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  incident_id uuid NOT NULL,
  seq integer NOT NULL,
  channel_id uuid,
  investigation_note text,
  last_paged_at timestamptz,
  acked_at timestamptz,
  page_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One overlay row per SRE incident.
CREATE UNIQUE INDEX IF NOT EXISTS reliability_incidents_incident_uk
  ON reliability_incidents (incident_id);
CREATE INDEX IF NOT EXISTS reliability_incidents_workspace_idx
  ON reliability_incidents (workspace_id);

CREATE TABLE IF NOT EXISTS reliability_pages (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source text NOT NULL,
  incident_id uuid,
  kind text NOT NULL,
  recipient text NOT NULL,
  delivered boolean NOT NULL DEFAULT false,
  suppressed_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reliability_pages_source_ck CHECK (source IN ('sre','uptime')),
  CONSTRAINT reliability_pages_kind_ck
    CHECK (kind IN ('opened','repaged','resolved','uptime_down','uptime_recover'))
);

-- The rate-limit window scans recent pages per workspace by time.
CREATE INDEX IF NOT EXISTS reliability_pages_workspace_created_idx
  ON reliability_pages (workspace_id, created_at);
