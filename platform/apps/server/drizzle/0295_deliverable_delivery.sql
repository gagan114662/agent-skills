-- Deliverable delivery receipts (#295, ADR-0295): the durable, production-grounded proof that an APPROVED
-- `agent.deliverable` actually SHIPPED — a live published URL, a social post id, or an email message id
-- (premortem #200 §2: an "it shipped" claim rests on an external receipt, never self-report). Numbered
-- 0295 by ISSUE (per ADR-0099, to dodge sibling-workspace collisions in the shared migration sequence).
-- Tenant boundary: workspace_id (#3, ON DELETE CASCADE).
--
-- ONE table. approval_request_id is the load-bearing column: every receipt ties back to the #13 approval
-- that authorized the ship — the structural proof nothing ships without an explicit owner approval. It and
-- session_id are SOFT references (the approval/session may be pruned independently and the receipt must
-- outlive them); only workspace_id carries the FK. `live` separates a genuine external surface from a
-- dry-run record so the console never overclaims a send. The name is intentionally NOT venture_/growth_-
-- prefixed so the #155 colocation gate does not class it as a governed metric surface.

CREATE TABLE IF NOT EXISTS delivery_receipts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  approval_request_id uuid NOT NULL,               -- soft ref to the #13 approval that authorized the ship
  session_id uuid,                                 -- soft ref to the agent session that drafted it
  channel text NOT NULL,                           -- publish | social | email
  reversibility text NOT NULL,                     -- reversible | irreversible (premortem #200 §4)
  provider text NOT NULL,                          -- github_pages | dryrun | ...
  live boolean NOT NULL DEFAULT false,             -- true ONLY for a real external surface (reachable URL / real id)
  external_ref text,                               -- the live URL / post id / message id (the receipt)
  status text NOT NULL,                            -- shipped | failed
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  shipped_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delivery_receipts_channel_ck CHECK (channel IN ('publish','social','email')),
  CONSTRAINT delivery_receipts_reversibility_ck CHECK (reversibility IN ('reversible','irreversible')),
  CONSTRAINT delivery_receipts_status_ck CHECK (status IN ('shipped','failed'))
);

CREATE INDEX IF NOT EXISTS delivery_receipts_workspace_shipped_idx
  ON delivery_receipts (workspace_id, shipped_at);
CREATE INDEX IF NOT EXISTS delivery_receipts_approval_idx
  ON delivery_receipts (approval_request_id);
