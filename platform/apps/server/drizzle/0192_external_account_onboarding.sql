-- External account onboarding (#192, ADR-0192): human-once setup, agent-forever operation. The owner
-- creates the account / accepts ToS / pastes keys ONCE per service; the fleet then operates through the
-- write-only vault. Numbered 0192 by ISSUE (per ADR-0099, to dodge sibling-workspace collisions in the
-- shared migration sequence). Tenant boundary throughout: workspace_id (#3 IDOR discipline).
--
-- THREE additive tables, no authority over any existing business-domain table:
--   1. external_setup_requests — the SETUP request the fleet files when a venture needs a service.
--   2. external_credentials    — the per-tenant WRITE-ONLY vault for arbitrary services (mirrors #68
--                                workspace_agent_credentials: secrets are sealed and NEVER read back by
--                                any API — only injected into a runtime as env, redacted by the manager).
--   3. dns_receipts            — immutable receipts of the DNS/SSL/SPF/DKIM/DMARC records the agent
--                                configures + verifies after the owner buys the domain (the money step).

-- 1. The setup request the fleet files (acceptance #1). It parks in the #13 decision queue via an
--    approval row (approval_request_id) so blocked-on-setup work ages visibly instead of failing silently.
CREATE TABLE IF NOT EXISTS external_setup_requests (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  service_key text NOT NULL,                       -- slug, e.g. 'sendgrid' | 'google_ads' | 'namecheap'
  service_kind text NOT NULL,                      -- esp | ad_account | analytics | registrar | hosting | payment | other
  display_name text NOT NULL,
  plan text,                                       -- which plan the fleet is asking for (nullable)
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,       -- which keys/scopes are needed
  reason text NOT NULL,                            -- why the venture needs it
  projected_cost_cents integer NOT NULL DEFAULT 0, -- projected monthly cost (the money the owner commits)
  reversibility text NOT NULL,                     -- reversible | cheap | irreversible (#200 reversibility class)
  status text NOT NULL DEFAULT 'requested',        -- requested | connected | dismissed
  -- The #13 approval that parks this in the decision queue. Soft (no FK) so the onboarding layer never
  -- gains authority over the approvals table and a swept/expired approval can't cascade-delete a request.
  approval_request_id uuid,
  requested_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_setup_requests_kind_ck
    CHECK (service_kind IN ('esp','ad_account','analytics','registrar','hosting','payment','other')),
  CONSTRAINT external_setup_requests_reversibility_ck
    CHECK (reversibility IN ('reversible','cheap','irreversible')),
  CONSTRAINT external_setup_requests_status_ck
    CHECK (status IN ('requested','connected','dismissed')),
  -- One live request per (workspace, service): re-filing upserts rather than stacking duplicates.
  CONSTRAINT external_setup_requests_service_uk UNIQUE (workspace_id, service_key)
);
CREATE INDEX IF NOT EXISTS external_setup_requests_workspace_idx
  ON external_setup_requests (workspace_id, created_at DESC);

-- 2. The write-only vault for arbitrary external services (acceptance #2/#4). One row per
--    (workspace, service) — the same shape that makes #68 pooling structurally impossible. `secrets` is a
--    map of env-var-name -> SEALED value (AES-256-GCM via crypto/secretbox, transparent when no key);
--    `env_keys` is the NON-secret list of which env vars exist (so the resolver knows what to inject and
--    the UI can show coverage without ever decrypting). `fingerprint` is non-reversible — for the
--    connected-state UI only. `status` flips to 'revoked' on disconnect so dependent capabilities go
--    offline gracefully without deleting the audit trail.
CREATE TABLE IF NOT EXISTS external_credentials (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  service_key text NOT NULL,
  secrets jsonb NOT NULL DEFAULT '{}'::jsonb,      -- { ENV_VAR: 'enc:...'|'raw:...' } — values SEALED, never returned
  env_keys jsonb NOT NULL DEFAULT '[]'::jsonb,     -- non-secret list of env var names present
  fingerprint text NOT NULL,                       -- non-reversible hash for the connected-state UI
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'connected',        -- connected | revoked
  rotation_reminder_days integer NOT NULL DEFAULT 0, -- 0 = no rotation reminder
  connected_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT external_credentials_status_ck CHECK (status IN ('connected','revoked')),
  CONSTRAINT external_credentials_pk PRIMARY KEY (workspace_id, service_key)
);

-- 3. Immutable DNS/SSL/email-auth receipts (acceptance #3). After the owner buys the domain (the money
--    step), the agent configures + verifies records autonomously and writes a receipt per record. These
--    are PUBLIC DNS records (SPF/DKIM/DMARC are published openly), so values are stored in plaintext.
CREATE TABLE IF NOT EXISTS dns_receipts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  domain text NOT NULL,
  record_type text NOT NULL,                       -- A | CNAME | TXT | MX | CAA
  name text NOT NULL,                              -- the host (e.g. '@' | 'mail' | '_dmarc')
  value text NOT NULL,                             -- the public record value
  purpose text NOT NULL,                           -- dns | ssl | spf | dkim | dmarc | verification
  status text NOT NULL,                            -- configured | verified | failed
  provider text NOT NULL,                          -- dryrun | cloudflare | ...
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dns_receipts_purpose_ck
    CHECK (purpose IN ('dns','ssl','spf','dkim','dmarc','verification')),
  CONSTRAINT dns_receipts_status_ck CHECK (status IN ('configured','verified','failed'))
);
CREATE INDEX IF NOT EXISTS dns_receipts_workspace_domain_idx
  ON dns_receipts (workspace_id, domain, created_at DESC);
