-- Reverse of 0053_plan_checkpoints_steering. session_turns references plan_proposals, so drop it first.
DROP TABLE IF EXISTS session_turns;
DROP TABLE IF EXISTS plan_proposals;
