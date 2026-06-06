import { uuidv7 } from "uuidv7";

/** Time-sortable UUIDv7 primary keys (ADR-0002). */
export function newId(): string {
  return uuidv7();
}
