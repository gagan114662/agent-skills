-- Revert #260: drop the onboarding state table. The Google connection rows live in the #192 vault and
-- are unaffected; a customer simply loses the persisted domain + bootstrap flag (re-derivable on next sign-in).
DROP TABLE IF EXISTS workspace_onboarding;
