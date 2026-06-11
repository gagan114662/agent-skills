-- 0114_customer_voice_loop — Customer Voice Loop (issue #114, ADR-0114).
-- Two additive, workspace-scoped tables that make post-launch customer voice a typed, tenant-scoped
-- input to the #96 venture scorecard, the #104 Founder Console, and the #107 portfolio loop — while the
-- only outbound path (a reply) stays a #13 sensitive-by-default external.send a human approves. No secret
-- lands here. number-by-issue (0114) to dodge sibling-branch migration-number collisions (see
-- drizzle/README.md).

-- The inbound support inbox. One row per inbound message (email/webhook/widget). The classifier writes
-- sentiment/churn_risk/category; draft_reply holds the agent's drafted (never auto-sent) reply;
-- reply_approval_request_id soft-links the #13 request once a reply is submitted. Deduped per workspace
-- by (channel, source_ref) so a replayed inbound webhook never double-creates a ticket.
CREATE TABLE support_tickets (
  id                        uuid PRIMARY KEY,
  workspace_id              uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  venture_idea_id           uuid REFERENCES venture_ideas(id) ON DELETE SET NULL,
  channel                   text NOT NULL,                       -- email | webhook | widget
  source_ref                text NOT NULL,                       -- external message id (dedupe key)
  contact                   text,                                -- who wrote in
  subject                   text,
  body                      text NOT NULL,
  sentiment                 text,                                -- positive | neutral | negative (classified)
  churn_risk                text,                                -- low | medium | high (classified)
  category                  text,                                -- bug|pricing|feature_request|praise|churn|support|other
  status                    text NOT NULL DEFAULT 'open',        -- open|triaged|awaiting_approval|replied|closed
  draft_reply               text,                                -- the drafted reply (never auto-sent)
  reply_approval_request_id uuid,                                -- soft link to the #13 request once submitted
  triage_session_id         uuid,                                -- soft link to the #59 triage session
  created_by_member_id      uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT support_tickets_channel_ref_uq UNIQUE (workspace_id, channel, source_ref)
);
CREATE INDEX support_tickets_workspace_idx ON support_tickets(workspace_id);
CREATE INDEX support_tickets_idea_idx ON support_tickets(venture_idea_id);
CREATE INDEX support_tickets_workspace_status_idx ON support_tickets(workspace_id, status);

-- The structured user_voice evidence log. One row per classified signal. kind is always 'user_voice'
-- (extends the #98 revenue_evidence kind-tagged evidence-row pattern); source_kind discriminates the
-- origin. Consumed by the #96 scorecard (overlaying problemSeverity), the #104 console, and #107.
-- Deduped per workspace by (source_kind, source_ref); a NULL source_ref is never deduped (NULLs distinct).
CREATE TABLE voice_insights (
  id              uuid PRIMARY KEY,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  venture_idea_id uuid REFERENCES venture_ideas(id) ON DELETE SET NULL,
  ticket_id       uuid REFERENCES support_tickets(id) ON DELETE SET NULL,  -- provenance back to the ticket
  kind            text NOT NULL DEFAULT 'user_voice',
  source_kind     text NOT NULL,                              -- support_ticket|checkout_abandon|cancellation|nps
  sentiment       text NOT NULL,                              -- positive | neutral | negative
  churn_risk      text NOT NULL,                              -- low | medium | high
  category        text NOT NULL,
  nps_score       integer,                                    -- 0–10 when source_kind = nps
  summary         text NOT NULL,
  source_ref      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT voice_insights_source_kind_ck CHECK (source_kind IN ('support_ticket','checkout_abandon','cancellation','nps')),
  CONSTRAINT voice_insights_sentiment_ck CHECK (sentiment IN ('positive','neutral','negative')),
  CONSTRAINT voice_insights_churn_ck CHECK (churn_risk IN ('low','medium','high')),
  CONSTRAINT voice_insights_nps_ck CHECK (nps_score IS NULL OR nps_score BETWEEN 0 AND 10),
  CONSTRAINT voice_insights_source_ref_uq UNIQUE (workspace_id, source_kind, source_ref)
);
CREATE INDEX voice_insights_workspace_idx ON voice_insights(workspace_id);
CREATE INDEX voice_insights_idea_idx ON voice_insights(venture_idea_id);
