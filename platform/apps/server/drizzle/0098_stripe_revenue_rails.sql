-- 0098_stripe_revenue_rails — Stripe revenue rails (issue #98, ADR-0043).
-- Three workspace-scoped tables, additive + independent of the #96 venture tables (the scorecard reads
-- revenue_evidence; neither branch depends on the other's schema). Secrets never land here; the webhook
-- raw payload is REDACTED before persistence. INBOUND money only — outbound (refunds/payouts/transfers)
-- is a #13 approval-gated, recorded-only action, never a row here.

-- A hosted payment link minted for a session's deployed app. Immutable (one row per link); deployment_id
-- is the "attach the link to the deployment record" association. Amounts only — no card data, no secret.
CREATE TABLE payment_links (
  id                     uuid PRIMARY KEY,
  workspace_id           uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id             uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  session_id             uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  deployment_id          uuid REFERENCES deployments(id) ON DELETE SET NULL,
  provider               text NOT NULL,                       -- none | stripe
  product_id             text NOT NULL,
  price_id               text NOT NULL,
  provider_link_id       text NOT NULL,
  url                    text NOT NULL,
  amount_cents           integer NOT NULL,
  currency               text NOT NULL,
  interval               text,                                -- day|week|month|year | null (one-time)
  created_by_member_id   uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payment_links_session_idx   ON payment_links (session_id);
CREATE INDEX payment_links_workspace_idx ON payment_links (workspace_id);

-- A real payment event from the provider's signature-verified webhook. Deduped per workspace by the
-- provider event id (the unique constraint), so a replayed delivery is a no-op. raw is the REDACTED body.
CREATE TABLE revenue_events (
  id                     uuid PRIMARY KEY,
  workspace_id           uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id             uuid REFERENCES channels(id) ON DELETE SET NULL,
  session_id             uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,
  deployment_id          uuid REFERENCES deployments(id) ON DELETE SET NULL,
  provider               text NOT NULL,                       -- none | stripe
  provider_event_id      text NOT NULL,                       -- the provider's event id (dedupe key)
  type                   text NOT NULL,                       -- e.g. checkout.session.completed
  amount_cents           integer NOT NULL DEFAULT 0,
  currency               text NOT NULL,
  status                 text NOT NULL,                       -- e.g. paid | succeeded | complete
  raw                    jsonb NOT NULL DEFAULT '{}'::jsonb,  -- REDACTED webhook payload
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT revenue_events_workspace_event_uq UNIQUE (workspace_id, provider_event_id)
);

CREATE INDEX revenue_events_workspace_idx ON revenue_events (workspace_id);
CREATE INDEX revenue_events_session_idx   ON revenue_events (session_id);

-- Willingness-to-pay evidence derived from a real payment — the ADDITIVE seam the #96 venture scorecard
-- consumes. A real charge is the strongest fundability signal. Independent of any #96 table.
CREATE TABLE revenue_evidence (
  id                     uuid PRIMARY KEY,
  workspace_id           uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id             uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,
  kind                   text NOT NULL,                       -- willingness_to_pay
  source                 text NOT NULL,                       -- revenue
  revenue_event_id       uuid REFERENCES revenue_events(id) ON DELETE CASCADE,
  amount_cents           integer NOT NULL DEFAULT 0,
  currency               text NOT NULL,
  summary                text NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX revenue_evidence_workspace_idx ON revenue_evidence (workspace_id);
CREATE INDEX revenue_evidence_session_idx   ON revenue_evidence (session_id);
