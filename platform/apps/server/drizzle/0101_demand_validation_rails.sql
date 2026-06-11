-- 0101_demand_validation_rails — Demand Validation Rails (issue #101, ADR-0101).
-- Three additive, workspace-scoped tables that make real-world demand a typed, non-circular pipeline on
-- top of the #96 venture loop + #98/#125 billing rails. No secret lands here. number-by-issue (0101) to
-- dodge sibling-branch migration-number collisions (see drizzle/README.md).

-- The locked experiment spec + lifecycle (registered → live → concluded). The bar columns
-- (success/denominator class, pass_threshold, min_sample, window_*) are written once at register and never
-- updated by the service — the anti-p-hacking guarantee. venture_idea_id soft-links the #96 idea.
CREATE TABLE demand_experiments (
  id                  uuid PRIMARY KEY,
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  venture_idea_id     uuid REFERENCES venture_ideas(id) ON DELETE SET NULL,
  hypothesis          text NOT NULL,
  success_class       text NOT NULL,                          -- visit|cta_click|checkout_started|waitlist|paid
  denominator_class   text NOT NULL,
  pass_threshold      double precision NOT NULL,              -- conversion rate (0,1]
  min_sample          integer NOT NULL,
  window_start_ms     bigint NOT NULL,                        -- sample window, epoch ms
  window_end_ms       bigint NOT NULL,
  availability        text NOT NULL,                          -- available | waitlist | preorder
  disclosure          text,                                   -- ethics disclosure (required pre-launch)
  status              text NOT NULL DEFAULT 'registered',     -- registered | live | concluded
  landing_url         text,
  checkout_url        text,
  created_by_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX demand_experiments_workspace_idx ON demand_experiments(workspace_id);
CREATE INDEX demand_experiments_idea_idx ON demand_experiments(venture_idea_id);

-- One externally-attributed funnel signal. external_ref is the attribution (a Stripe event id, an
-- anonymized visitor token) — the proof the action came from outside the building. Deduped per experiment
-- by the external ref so a replayed webhook/funnel post never double-counts.
CREATE TABLE demand_signals (
  id              uuid PRIMARY KEY,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  experiment_id   uuid NOT NULL REFERENCES demand_experiments(id) ON DELETE CASCADE,
  venture_idea_id uuid REFERENCES venture_ideas(id) ON DELETE SET NULL,
  signal_class    text NOT NULL,                              -- visit|cta_click|checkout_started|waitlist|paid
  source          text NOT NULL,                              -- the external touchpoint
  external_ref    text NOT NULL,
  amount_cents    integer NOT NULL DEFAULT 0,
  currency        text NOT NULL DEFAULT 'usd',
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT demand_signals_experiment_ref_uq UNIQUE (workspace_id, experiment_id, external_ref)
);
CREATE INDEX demand_signals_experiment_idx ON demand_signals(experiment_id);
CREATE INDEX demand_signals_idea_idx ON demand_signals(venture_idea_id);

-- The ethics auto-refund audit — one row per pre-availability charge that was instantly refunded.
CREATE TABLE demand_refunds (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  experiment_id uuid NOT NULL REFERENCES demand_experiments(id) ON DELETE CASCADE,
  external_ref  text NOT NULL,
  amount_cents  integer NOT NULL DEFAULT 0,
  currency      text NOT NULL,
  reason        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX demand_refunds_experiment_idx ON demand_refunds(experiment_id);
