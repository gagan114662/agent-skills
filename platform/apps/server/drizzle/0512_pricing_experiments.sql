-- 0512_pricing_experiments — A/B pricing cohorts and conversion reporting (#608).
-- Sticky assignments make the shown package durable for returning visitors; webhook conversion writes
-- attach real revenue back to the assigned variant.

CREATE TABLE pricing_experiments (
  id                   uuid PRIMARY KEY,
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                 text NOT NULL,
  status               text NOT NULL DEFAULT 'active',
  control_variant_key  text NOT NULL,
  min_sample_size      integer NOT NULL DEFAULT 30,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pricing_experiments_status_ck CHECK (status IN ('active','paused','completed')),
  CONSTRAINT pricing_experiments_min_sample_ck CHECK (min_sample_size > 0)
);

CREATE INDEX pricing_experiments_workspace_idx
  ON pricing_experiments(workspace_id, status);

CREATE TABLE pricing_experiment_variants (
  experiment_id  uuid NOT NULL REFERENCES pricing_experiments(id) ON DELETE CASCADE,
  variant_key    text NOT NULL,
  plan_key       text NOT NULL,
  label          text NOT NULL,
  weight_bps     integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (experiment_id, variant_key),
  CONSTRAINT pricing_experiment_variants_weight_ck CHECK (weight_bps > 0)
);

CREATE TABLE pricing_experiment_assignments (
  id                   uuid PRIMARY KEY,
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  experiment_id         uuid NOT NULL REFERENCES pricing_experiments(id) ON DELETE CASCADE,
  subject_key           text NOT NULL,
  variant_key           text NOT NULL,
  plan_key              text NOT NULL,
  checkout_started_at   timestamptz,
  converted_at          timestamptz,
  revenue_event_id      text,
  revenue_cents         integer NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pricing_experiment_assignments_subject_uq UNIQUE (experiment_id, subject_key),
  CONSTRAINT pricing_experiment_assignments_revenue_ck CHECK (revenue_cents >= 0)
);

CREATE INDEX pricing_experiment_assignments_experiment_idx
  ON pricing_experiment_assignments(workspace_id, experiment_id);
