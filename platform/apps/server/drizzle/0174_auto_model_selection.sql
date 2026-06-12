-- Auto model-selection via convene-llm-gateway (Claude-orchestrated). Adds the "why?" audit record to
-- agent_sessions: when a session's model is auto-chosen, the routing decision (chosen model, stage,
-- rationale, validation verdict, escalations, cost) is stored so the owner can always see WHY a model
-- was picked. Numbered 0174 by sequence after the latest issue migration (0173); a single additive,
-- nullable column ⇒ zero collision risk with sibling workspaces and a no-op for every existing row.
--
-- Secret-free + prompt-free: the gateway's RoutingRecord never stores prompt content or keys, and this
-- column carries only that record. Credentials NEVER live here — they stay on the #25 SecretsResolver path.
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS selection_meta jsonb;
