-- Down-migration for #192 (ADR-0192). Drops the external-account-onboarding tables (setup requests,
-- the write-only external credentials vault, DNS receipts). Additive-only up ⇒ a clean reverse.
DROP INDEX IF EXISTS dns_receipts_workspace_domain_idx;
DROP TABLE IF EXISTS dns_receipts;
DROP TABLE IF EXISTS external_credentials;
DROP INDEX IF EXISTS external_setup_requests_workspace_idx;
DROP TABLE IF EXISTS external_setup_requests;
