CREATE TABLE IF NOT EXISTS referral_codes (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS referral_codes_workspace_uq
  ON referral_codes (workspace_id);

CREATE TABLE IF NOT EXISTS referral_signups (
  id uuid PRIMARY KEY,
  referral_code_id uuid NOT NULL REFERENCES referral_codes(id) ON DELETE CASCADE,
  referrer_workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  referred_workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  referred_member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  tracking_ref text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS referral_signups_referrer_idx
  ON referral_signups (referrer_workspace_id, occurred_at);

CREATE UNIQUE INDEX IF NOT EXISTS referral_signups_referred_uq
  ON referral_signups (referred_workspace_id);

CREATE TABLE IF NOT EXISTS referral_incentives (
  id uuid PRIMARY KEY,
  referral_signup_id uuid NOT NULL REFERENCES referral_signups(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL,
  status text NOT NULL,
  amount_cents integer NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  fulfilled_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS referral_incentives_workspace_idx
  ON referral_incentives (workspace_id, created_at);

ALTER TABLE referral_incentives
  ADD CONSTRAINT referral_incentives_signup_workspace_kind_uq
  UNIQUE (referral_signup_id, workspace_id, kind);
