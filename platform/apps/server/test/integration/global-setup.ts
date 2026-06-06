import { runMigrations } from "../../src/db/migrate.js";

/** Ensure the schema is applied before integration tests run (idempotent). */
export default async function setup(): Promise<void> {
  await runMigrations("up");
}
