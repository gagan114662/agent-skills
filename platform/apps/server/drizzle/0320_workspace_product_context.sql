-- #320: capture per-workspace product context so briefed agents act on real facts, not placeholders.
-- The customer's primary site URL is already captured as workspace_onboarding.domain (#260); this adds
-- the owner-typed product description. Surfaced to agents as sanitized reference DATA (never instructions)
-- via marketing/workspace-context.ts. Not a governed metric table — does not gate skill colocation.
ALTER TABLE workspace_onboarding ADD COLUMN IF NOT EXISTS product_context text;
