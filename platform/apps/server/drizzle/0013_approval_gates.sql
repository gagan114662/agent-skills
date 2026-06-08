-- 0013_approval_gates — human approval gates & governance for sensitive agent actions.
-- Issue #13, ADR-0013. Additive on top of #2 (workspaces/members), #4/#5 (channels/messages/
-- realtime — the chat executor), #8 (notifications — the reserved `approval` type), #9 (RBAC).
-- Three new independent tables; no existing table is touched. Numbered 0013 — a free slot
-- (prior numbers are 0000–0007 ×2 and 0025).

-- Per-workspace policy rules: which action types pause for a human. require_approval gates a type
-- outright; max_auto_amount (when set) re-gates a spend above the threshold. One rule per
-- (workspace, action_type). No rule for a type → the DEFAULT_SENSITIVE_ACTIONS fallback in code.
CREATE TABLE approval_policies (
  id                    uuid PRIMARY KEY,
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  action_type           text NOT NULL,
  require_approval      boolean NOT NULL DEFAULT true,
  max_auto_amount       double precision,
  created_by_member_id  uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_policies_uniq UNIQUE (workspace_id, action_type)
);

-- A gated action awaiting (or having received) a human decision. payload is the full action
-- descriptor re-passed to the executor; summary snapshots it for the review queue / inbox.
-- status walks pending → {executed,failed} (approve) | rejected | expired. expires_at is the
-- lazy-expiry deadline. result/error capture the executor outcome.
CREATE TABLE approval_requests (
  id                    uuid PRIMARY KEY,
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requester_member_id   uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  action_type           text NOT NULL,
  payload               jsonb NOT NULL DEFAULT '{}'::jsonb,
  amount                double precision,
  summary               text NOT NULL,
  status                text NOT NULL DEFAULT 'pending',
  reason                text,
  decided_by_member_id  uuid REFERENCES members(id) ON DELETE SET NULL,
  decided_at            timestamptz,
  expires_at            timestamptz,
  result                jsonb,
  error                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_requests_status_ck
    CHECK (status IN ('pending','approved','executed','failed','rejected','expired'))
);
-- review queue: a workspace's requests filtered by status
CREATE INDEX approval_requests_workspace_status_idx ON approval_requests (workspace_id, status);

-- Append-only audit of everything that happens to a request (ADR-0013 §7). Written in the same
-- transaction as the mutation; never updated or deleted.
CREATE TABLE approval_events (
  id                uuid PRIMARY KEY,
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id        uuid NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  type              text NOT NULL,
  actor_member_id   uuid REFERENCES members(id) ON DELETE SET NULL,
  detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- audit trail for one request, chronological
CREATE INDEX approval_events_request_created_idx ON approval_events (request_id, created_at);
