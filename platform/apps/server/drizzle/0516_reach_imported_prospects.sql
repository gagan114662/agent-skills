ALTER TABLE reach_contacts DROP CONSTRAINT IF EXISTS reach_contacts_status_ck;
ALTER TABLE reach_contacts
  ADD CONSTRAINT reach_contacts_status_ck CHECK (status IN ('imported','active','completed','replied','opted_out'));

ALTER TABLE reach_contacts
  ADD COLUMN IF NOT EXISTS full_name text,
  ADD COLUMN IF NOT EXISTS title text,
  ADD COLUMN IF NOT EXISTS company text,
  ADD COLUMN IF NOT EXISTS company_domain text,
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS linkedin_url text,
  ADD COLUMN IF NOT EXISTS industry text,
  ADD COLUMN IF NOT EXISTS company_size text,
  ADD COLUMN IF NOT EXISTS signals jsonb;
