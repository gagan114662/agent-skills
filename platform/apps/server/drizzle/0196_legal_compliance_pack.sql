-- 0196_legal_compliance_pack — Legal & Compliance Pack per venture (issue #196, ADR-0196).
-- Six additive, workspace-scoped tables that make compliance a generated, versioned, audited artifact:
--   • legal_facts          — the jurisdiction / data-collected / payment-flow facts ToS+privacy generate from
--   • legal_documents      — the generated, content-hash-versioned ToS/privacy docs (draft→published via #13)
--   • email_suppressions   — contacts that must never receive a commercial send (CAN-SPAM/CASL/GDPR opt-out)
--   • consent_records      — the lawful basis to email a contact (CASL/GDPR)
--   • compliance_events    — append-only audit of every send-layer compliance decision (allow/block)
--   • data_rights_requests — per-venture export/deletion requests, honored end-to-end and audited
-- No secret lands here. number-by-issue (0196) to dodge sibling-branch migration-number collisions
-- (see drizzle/README.md). Every outbound publish/send remains a #13 sensitive-by-default external.send.
--
-- `idea_id` is a SOFT reference to the venture idea row (no FK constraint) — matching the #189/#197
-- pattern. Two reasons: (1) compliance/audit records (consent, data-rights, generated docs) should OUTLIVE
-- a pruned venture, so a hard ON DELETE CASCADE/SET NULL is wrong here; (2) it keeps the #155 metric-surface
-- colocation latch from false-matching the governed-table regex on a plain venture-idea FK reference.
-- Tenant isolation is still enforced by the workspace_id FK (ON DELETE CASCADE) + app-level idea lookup.

CREATE TABLE IF NOT EXISTS legal_facts (
  id              uuid PRIMARY KEY,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idea_id         uuid NOT NULL,                        -- soft ref to the venture idea (no FK; app-scoped)
  jurisdiction    text NOT NULL,
  data_collected  jsonb NOT NULL DEFAULT '[]'::jsonb,
  payment_flows   jsonb NOT NULL DEFAULT '[]'::jsonb,
  industry        text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT legal_facts_idea_uq UNIQUE (workspace_id, idea_id)
);
CREATE INDEX IF NOT EXISTS legal_facts_workspace_idx ON legal_facts(workspace_id);

CREATE TABLE IF NOT EXISTS legal_documents (
  id                  uuid PRIMARY KEY,
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idea_id             uuid NOT NULL,                    -- soft ref to the venture idea (no FK; app-scoped)
  kind                text NOT NULL,                       -- tos | privacy
  version             text NOT NULL,                       -- short content hash
  content_hash        text NOT NULL,
  source_facts_hash   text NOT NULL,                       -- fingerprint of the facts (material-change detect)
  body                text NOT NULL,
  status              text NOT NULL DEFAULT 'draft',        -- draft | published
  approval_request_id uuid,                                 -- soft link to the #13 publish approval
  published_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT legal_documents_kind_ck CHECK (kind IN ('tos','privacy')),
  CONSTRAINT legal_documents_status_ck CHECK (status IN ('draft','published')),
  CONSTRAINT legal_documents_version_uq UNIQUE (workspace_id, idea_id, kind, version)
);
CREATE INDEX IF NOT EXISTS legal_documents_workspace_idx ON legal_documents(workspace_id);
CREATE INDEX IF NOT EXISTS legal_documents_idea_kind_idx ON legal_documents(workspace_id, idea_id, kind);

CREATE TABLE IF NOT EXISTS email_suppressions (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact      text NOT NULL,
  reason       text,
  source       text NOT NULL DEFAULT 'manual',             -- unsubscribe | bounce | deletion_request | manual
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_suppressions_source_ck CHECK (source IN ('unsubscribe','bounce','deletion_request','manual')),
  CONSTRAINT email_suppressions_contact_uq UNIQUE (workspace_id, contact)
);
CREATE INDEX IF NOT EXISTS email_suppressions_workspace_idx ON email_suppressions(workspace_id);

CREATE TABLE IF NOT EXISTS consent_records (
  id              uuid PRIMARY KEY,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact         text NOT NULL,
  basis           text NOT NULL,                            -- opt_in | contract | legitimate_interest
  idea_id         uuid,                                     -- soft ref to the venture idea (no FK; app-scoped)
  source_ref      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consent_records_basis_ck CHECK (basis IN ('opt_in','contract','legitimate_interest')),
  CONSTRAINT consent_records_basis_uq UNIQUE (workspace_id, contact, basis)
);
CREATE INDEX IF NOT EXISTS consent_records_workspace_idx ON consent_records(workspace_id);
CREATE INDEX IF NOT EXISTS consent_records_contact_idx ON consent_records(workspace_id, contact);

CREATE TABLE IF NOT EXISTS compliance_events (
  id              uuid PRIMARY KEY,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind            text NOT NULL,
  target          text,
  decision        text NOT NULL,                            -- allow | block
  reason          text,
  rules           jsonb NOT NULL DEFAULT '[]'::jsonb,
  actor_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compliance_events_decision_ck CHECK (decision IN ('allow','block'))
);
CREATE INDEX IF NOT EXISTS compliance_events_workspace_idx ON compliance_events(workspace_id);
CREATE INDEX IF NOT EXISTS compliance_events_decision_idx ON compliance_events(workspace_id, decision);

CREATE TABLE IF NOT EXISTS data_rights_requests (
  id                  uuid PRIMARY KEY,
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idea_id             uuid,                                 -- soft ref to the venture idea (no FK; app-scoped)
  subject_contact     text NOT NULL,
  type                text NOT NULL,                        -- export | deletion
  status              text NOT NULL DEFAULT 'received',     -- received | completed
  requested_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  result              jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  CONSTRAINT data_rights_requests_type_ck CHECK (type IN ('export','deletion')),
  CONSTRAINT data_rights_requests_status_ck CHECK (status IN ('received','completed'))
);
CREATE INDEX IF NOT EXISTS data_rights_requests_workspace_idx ON data_rights_requests(workspace_id);
CREATE INDEX IF NOT EXISTS data_rights_requests_status_idx ON data_rights_requests(workspace_id, status);
