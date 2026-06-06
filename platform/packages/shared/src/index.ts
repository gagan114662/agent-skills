/**
 * Cross-cutting contracts shared between the Reload server, web client, and CLI.
 * Keep this package free of runtime dependencies — types and small pure helpers only.
 */

/** Health of a single backing dependency. */
export type DependencyState = "up" | "down";

/** Overall service health, returned by `GET /healthz`. */
export interface HealthResponse {
  status: "ok" | "degraded";
  db: DependencyState;
  redis: DependencyState;
}
