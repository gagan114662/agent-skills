-- Revert #266 (ADR-0266): drop the hosted-publishing tables (children first) and their indexes.
DROP INDEX IF EXISTS hosted_page_views_page_idx;
DROP TABLE IF EXISTS hosted_page_views;

DROP INDEX IF EXISTS hosted_pages_workspace_idx;
DROP INDEX IF EXISTS hosted_pages_site_slug_uq;
DROP TABLE IF EXISTS hosted_pages;

DROP INDEX IF EXISTS hosted_sites_workspace_idx;
DROP INDEX IF EXISTS hosted_sites_custom_domain_uq;
DROP INDEX IF EXISTS hosted_sites_subdomain_uq;
DROP TABLE IF EXISTS hosted_sites;
