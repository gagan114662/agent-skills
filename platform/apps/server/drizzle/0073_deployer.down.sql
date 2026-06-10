-- Down: 0073_deployer (issue #73). Drops the deployments table (indexes + self-FK go with it).
DROP TABLE IF EXISTS deployments;
