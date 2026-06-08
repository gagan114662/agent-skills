-- Reverse of 0013_approval_gates.
DROP TABLE IF EXISTS governance_policies;
DROP INDEX IF EXISTS approval_requests_requester_idx;
DROP INDEX IF EXISTS approval_requests_workspace_idx;
DROP TABLE IF EXISTS approval_requests;
