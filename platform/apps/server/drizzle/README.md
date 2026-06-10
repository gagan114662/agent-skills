# Migrations (`drizzle/`)

Plain SQL migrations applied by the minimal runner in [`../src/db/migrate.ts`](../src/db/migrate.ts):

```bash
pnpm --filter @reload/server db:migrate     # apply all pending NNNN_*.sql (up)
pnpm --filter @reload/server db:rollback     # revert the most recent (down)
pnpm --filter @reload/server db:reset        # revert all, then re-apply
```

Each `NNNN_name.sql` has a paired `NNNN_name.down.sql`. Applied migrations are tracked by **filename**
in the `_migrations` table.

## Ordering (and duplicate prefixes)

Migrations run in **full-filename lexicographic order**, not by numeric prefix. `down` reverts in the
exact reverse (`ORDER BY name DESC`). This makes a duplicate numeric prefix deterministic:

| Prefix | Files (apply order) | Down order |
|--------|--------------------|------------|
| `0007` | `0007_notifications.sql` → `0007_shared_memory.sql` | `0007_shared_memory` → `0007_notifications` |

`"0007_notifications" < "0007_shared_memory"` because `n` < `s`, so the suffix breaks the tie. The
duplicate `0007` arose from two sibling feature branches (#8 notifications, #16 shared memory) each
reserving the next free number. It is **safe**: both are additive and mutually independent — neither
touches a table the other defines — so either order produces the same schema and the reverse order
unwinds cleanly.

## Why we don't renumber

`_migrations` stores the applied **filename**. Renaming a shipped migration would orphan that ledger
row on every already-migrated database (the renamed file would look "pending" and re-run, or its
`down` would never match). New migrations should pick the next unused prefix; if a collision is
unavoidable across parallel branches, the suffix keeps ordering deterministic, so it is documented
here rather than rewritten.
