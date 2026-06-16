-- Non-technical onboarding (#260): one screen — "enter your domain → Sign in with Google".
-- The Google OAuth callback creates/attaches a workspace; this table persists the typed domain + the
-- post-signin bootstrap status (the Google tokens themselves are sealed in the #192 external_credentials
-- vault under service_key 'google' — no new credential store). One row per workspace.
-- Numbered 0260 by ISSUE (per ADR-0099) to dodge sibling-workspace collisions in the shared sequence.

CREATE TABLE IF NOT EXISTS workspace_onboarding (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  domain text,
  bootstrapped_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
