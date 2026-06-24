ALTER TABLE reach_contacts DROP CONSTRAINT IF EXISTS reach_contacts_status_ck;
ALTER TABLE reach_contacts
  ADD CONSTRAINT reach_contacts_status_ck CHECK (status IN ('active','completed','replied','opted_out'));

ALTER TABLE reach_contacts
  DROP COLUMN IF EXISTS signals,
  DROP COLUMN IF EXISTS company_size,
  DROP COLUMN IF EXISTS industry,
  DROP COLUMN IF EXISTS linkedin_url,
  DROP COLUMN IF EXISTS email,
  DROP COLUMN IF EXISTS company_domain,
  DROP COLUMN IF EXISTS company,
  DROP COLUMN IF EXISTS title,
  DROP COLUMN IF EXISTS full_name;
