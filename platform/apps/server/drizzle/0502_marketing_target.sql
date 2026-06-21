-- #502: capture the structured MARKETING TARGET so the fleet markets the chosen product/app — its own or
-- any external one — instead of inferring ipop. The target's URL reuses workspace_onboarding.domain (#260)
-- and the brand voice reuses the brand kit (#271); these columns add the rest of the brief. Owner-typed,
-- surfaced to agents as sanitized reference DATA (never instructions) via marketing/workspace-context.ts.
-- Not a governed metric table — does not gate skill colocation.
ALTER TABLE workspace_onboarding ADD COLUMN IF NOT EXISTS target_name text;
ALTER TABLE workspace_onboarding ADD COLUMN IF NOT EXISTS target_positioning text;
ALTER TABLE workspace_onboarding ADD COLUMN IF NOT EXISTS target_audience text;
ALTER TABLE workspace_onboarding ADD COLUMN IF NOT EXISTS target_competitors text;
