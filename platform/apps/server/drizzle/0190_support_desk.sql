-- 0190_support_desk — Support Desk (issue #190, ADR-0190).
-- Two additive, workspace-scoped tables that layer the bounded-autonomy support desk on the #114 voice
-- inbox: a per-venture knowledge base (the source of every answer's receipts) and an external-receipt log
-- (the ONLY trustworthy resolution signal — premortem #200 §2). The ticket inbox itself is #114's
-- support_tickets, reused as-is; SLA is computed from ticket age, so no SLA table. No secret lands here.
-- number-by-issue (0190) to dodge sibling-branch migration-number collisions (see drizzle/README.md).

-- The venture knowledge base. The venture's OWN, trusted content — curated entries + distilled
-- resolutions. A support answer is assembled FROM these rows (never echoed from the customer's untrusted
-- message), and every drafted answer cites the entry ids it drew from (AC2 "with receipts"). A resolved
-- ticket distills into a new row with source='resolved_ticket' (AC4 — the desk learns). Deduped per
-- workspace by slug so re-distilling the same resolution updates rather than duplicates.
CREATE TABLE IF NOT EXISTS support_kb_entries (
  id                   uuid PRIMARY KEY,
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  venture_idea_id      uuid REFERENCES venture_ideas(id) ON DELETE SET NULL,
  slug                 text NOT NULL,                       -- stable per-workspace dedup key
  title                text NOT NULL,
  body                 text NOT NULL,
  category             text NOT NULL,
  source               text NOT NULL DEFAULT 'manual',      -- manual | resolved_ticket
  source_ticket_id     uuid REFERENCES support_tickets(id) ON DELETE SET NULL,
  provenance           text NOT NULL,                       -- where this entry came from (the receipt's receipt)
  created_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT support_kb_entries_source_ck CHECK (source IN ('manual','resolved_ticket')),
  CONSTRAINT support_kb_entries_slug_uq UNIQUE (workspace_id, slug)
);
CREATE INDEX IF NOT EXISTS support_kb_entries_workspace_idx ON support_kb_entries(workspace_id);
CREATE INDEX IF NOT EXISTS support_kb_entries_workspace_category_idx ON support_kb_entries(workspace_id, category);
CREATE INDEX IF NOT EXISTS support_kb_entries_idea_idx ON support_kb_entries(venture_idea_id);

-- The external-receipt log. One row per delivery/resolution event from a provider (a signed webhook).
-- This is the ONLY signal that counts a ticket "resolved (verified)"; a self-reported status='closed' is
-- reported separately and labeled UNVERIFIED, and never drives a kill/scale decision (premortem #200 §2).
-- Deduped per workspace by (ticket_id, kind, provider_ref) so a replayed receipt webhook is idempotent.
CREATE TABLE IF NOT EXISTS support_receipts (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ticket_id    uuid REFERENCES support_tickets(id) ON DELETE SET NULL,
  kind         text NOT NULL,                               -- delivered|opened|bounced|resolved (external) | auto_sent (internal marker)
  provider_ref text NOT NULL,                               -- external event id / approval request id (dedupe key)
  detail       text,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- delivered/opened/bounced/resolved are external provider events; auto_sent is the platform's own
  -- audit marker for an autonomous reply (the per-day cap counter), never counted as a resolution.
  CONSTRAINT support_receipts_kind_ck CHECK (kind IN ('delivered','opened','bounced','resolved','auto_sent')),
  CONSTRAINT support_receipts_ref_uq UNIQUE (workspace_id, ticket_id, kind, provider_ref)
);
CREATE INDEX IF NOT EXISTS support_receipts_workspace_idx ON support_receipts(workspace_id);
CREATE INDEX IF NOT EXISTS support_receipts_ticket_idx ON support_receipts(ticket_id);
