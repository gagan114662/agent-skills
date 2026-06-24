-- 0513_trial_nurture — free-trial nudges, email nurture drafts, and trial-to-paid measurement (#607).

CREATE TABLE trial_nurture_profiles (
  id                  uuid PRIMARY KEY,
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  member_id           uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  variant_key         text NOT NULL,
  first_value_at      timestamptz,
  upgrade_clicked_at  timestamptz,
  paid_at             timestamptz,
  provider_event_id   text,
  revenue_cents       integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trial_nurture_profiles_member_uq UNIQUE (workspace_id, member_id),
  CONSTRAINT trial_nurture_profiles_variant_ck CHECK (variant_key IN ('aha_first','upgrade_moment')),
  CONSTRAINT trial_nurture_profiles_revenue_ck CHECK (revenue_cents >= 0)
);

CREATE INDEX trial_nurture_profiles_workspace_idx
  ON trial_nurture_profiles(workspace_id, variant_key);

CREATE TABLE trial_nurture_events (
  id          uuid PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES trial_nurture_profiles(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trial_nurture_events_kind_ck CHECK (kind IN ('nudge_view','email_draft','first_value','upgrade_click','paid'))
);

CREATE INDEX trial_nurture_events_profile_idx
  ON trial_nurture_events(profile_id, kind);
