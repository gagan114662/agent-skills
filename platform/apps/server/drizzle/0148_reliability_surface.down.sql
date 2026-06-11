-- Revert #148 reliability surface.
DROP INDEX IF EXISTS reliability_pages_workspace_created_idx;
DROP TABLE IF EXISTS reliability_pages;
DROP INDEX IF EXISTS reliability_incidents_workspace_idx;
DROP INDEX IF EXISTS reliability_incidents_incident_uk;
DROP TABLE IF EXISTS reliability_incidents;
