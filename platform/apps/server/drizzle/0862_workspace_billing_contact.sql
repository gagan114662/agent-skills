ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS billing_email text;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS stripe_customer_id text;
