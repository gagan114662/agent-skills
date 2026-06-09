# Spec: Reload Platform — Cloud↔Local File Sync + Persistent & Shared Workspaces (Issue #55)

> Implements [#55](https://github.com/gagan114662/agent-skills/issues/55). Feature phase 4 —
> Real execution & Conductor parity. **Depends on #25** (cloud runtime); independent of #50.
> Lifecycle: **DEFINE** artifact (`spec-driven-development`). Built the agent_skills way — every
> stage governed by a skill in `skills/`.

## Objective
**What:** Make cloud agent work **durable and collaborative**. Today (#25) a session runs
server-side on an `AgentRuntime` and streams into a channel, but the filesystem it produces is
ephemeral (snapshot-on-teardown only) and single-user. This issue adds three things:

1. **File sync / mirroring (cloud↔local)** with **setup-on-first-mirror** — pull a cloud
   workspace's files down to a local directory (diff by content hash, apply add/update/delete),
   and run a one-time setup command the *first* time a workspace is mirrored.
2. **Persistent + sleeping cloud workspaces** — a durable cloud workspace record that survives
   across sessions, can be **slept** (idle → archived state, latest snapshot retained) and
   **woken** (resume from the retained snapshot — fast spin-up via #25's snapshot path).
3. **Shared workspaces with revocable collaborator access** — invite another member to a cloud
   workspace at an RBAC-scoped (#9) capability, see **live presence** of who is attached (#5),
   and **revoke** access so it is cut immediately (REST + a live socket signal).

**Why:** Conductor Cloud mirrors cloud-workspace files to local, sleeps/archives idle cloud
workspaces, and supports shared workspaces with revocable collaborator access. We have cloud
*execution* (#25 + Vercel Sandbox) but no sync/mirroring or multi-user sharing — the gap between
"an agent ran in the cloud" and "a team works on a durable cloud environment together." This is
the Conductor-parity layer on top of #25.

**Who:** A user who launches cloud sessions and wants the files locally; a user who wants a
cloud workspace to persist (and not burn resources while idle); a second collaborator who is
granted scoped, revocable access to a live shared workspace; operators who must keep access
tenant-isolated and secrets out of synced files.

### Acceptance criteria (from #55)
1. **Cloud session files mirror locally and run setup once** — mirroring applies the cloud
   manifest to a local sink (add/update/delete by hash) and runs the setup command exactly once,
   on the first mirror, never again.
2. **A second user with granted access sees the live session; revoke cuts access** — an invited
   collaborator (scoped capability) can read the shared workspace and watch live presence; after
   revoke, both REST access and the live watch are cut.
3. **A slept workspace wakes and resumes** — sleeping a workspace retains its latest snapshot;
   waking returns it to `active` and yields the snapshot id so the next session resumes from it.

### In scope
- **Durable cloud workspace** (`cloud_workspaces`): a tenant-scoped record with a lifecycle
  (`active | sleeping | archived`), the latest filesystem `snapshot_id` (resume key), a
  `setup_completed` flag (setup-on-first-mirror), an owner, and `last_active_at` (idle sweep).
- **Sync/mirror protocol** (`workspace/sync.ts`): a content-hash manifest diff between a
  `MirrorSource` (cloud) and a `MirrorSink` (local), applied as writes/removes. An in-memory
  source/sink for hermetic tests and an `FsMirrorSink` that writes a real local directory. The
  protocol is **transport-agnostic** (the real cloud source is a thin adapter over the #25
  sandbox/snapshot; tests inject fakes — no cloud spend).
- **Setup-on-first-mirror**: the manager runs a provided `runSetup()` once when
  `setup_completed` is false, then records it — idempotent across repeated mirrors.
- **Sleep / wake / idle sweep** (`workspace/manager.ts`): state transitions + a `recordSnapshot`
  hook (called when a session tears down) + an opt-in background `sweepIdle` that sleeps
  workspaces idle longer than `CLOUD_IDLE_MS` (default `0` = off, like the #17 loop).
- **Collaborator sharing** (`cloud_workspace_collaborators` + `auth/access.ts`): invite a member
  at `read|write|propagate` (the #9 ladder), revocable (`revoked_at`); the **owner** implicitly
  holds `propagate`. A single `requireCloudWorkspaceCapability` access call carries the #3 IDOR
  discipline (cross-tenant = 404) + the #9 ladder.
- **Shared-session presence** (reuse #5): `watch`/`unwatch` socket commands gated by collaborator
  access; `workspace_presence` (joined/left) fan-out over Redis pub/sub; an `access_revoked`
  signal that drops a revoked member's live watch.
- **REST surface** (tenant- + capability-gated): create / list / get / sleep / wake / manifest;
  collaborators list / invite / revoke.
- **Observability**: dependency-free counters extending the #19 registry (`cloud_workspace_sleeps_total`,
  `cloud_workspace_wakes_total`, `cloud_workspace_syncs_total`, `cloud_workspace_files_synced_total`),
  with the same cardinality discipline (no tenant labels).

### Out of scope (deferred / documented-not-automated)
- **Multi-region placement** of cloud workspaces — single region (per #25).
- **Warm-pool tuning** (#17) — wake provisions on demand from the snapshot.
- **Real-time collaborative file editing / CRDT** — sync is one-way pull (cloud→local) + manifest;
  bi-directional conflict resolution is a follow-up.
- **Real Vercel/cloud calls in CI** — the cloud `MirrorSource` adapter is behind the seam; tests
  inject fakes, so no cloud spend (the #25 boundary).
- **Binary-diff/delta transfer** — files are transferred whole when their hash changes.

## Architecture

```
                       REST (tenant + #9 gated)
  routes/cloud-workspaces.ts ──► repositories ──► cloud_workspaces
        │                                          cloud_workspace_collaborators
        ├──► CloudWorkspaceManager (sleep/wake/recordSnapshot/sweepIdle/syncToLocal)
        │         │
        │         └──► workspace/sync.ts  mirror(MirrorSource → MirrorSink)  + setup-once
        │
        └──► auth/access.ts  requireCloudWorkspaceCapability (owner=propagate, collab=cap, revoked=∅)

  realtime/gateway.ts  watch/unwatch ──► byCloudWorkspace routing ──► workspace_presence (#5 bus)
                                          revoke ──► access_revoked ──► drop watcher
```

- **Naming:** the tenant is a `workspace` (existing). The durable cloud filesystem environment is
  a **`cloud_workspace`** to avoid collision. One tenant has many cloud workspaces.
- **Snapshot reuse:** #25 already snapshots a sandbox filesystem at teardown and can resume from a
  `snapshotId` at provision. A cloud workspace stores the *latest* such snapshot; sleep retains
  it, wake yields it, the next session resumes from it. No new snapshot mechanism.
- **Secrets:** #25 keeps secrets env-injected and out of snapshots. Sync mirrors **files only**,
  from a snapshot/manifest that already excludes secrets — so synced local files never carry a
  secret. The sync layer adds no secret handling of its own and never logs file contents.

## Data model
**`cloud_workspaces`** — `id, workspace_id, name, status('active'|'sleeping'|'archived'),
snapshot_id, setup_completed(bool), created_by_member_id, last_active_at, created_at`. Indexed by
`workspace_id` and by `status` (idle sweep). Migration `0032` + down.

**`cloud_workspace_collaborators`** — `id, cloud_workspace_id, member_id, capability('read'|'write'|
'propagate'), granted_by_member_id, granted_at, revoked_at`. `UNIQUE(cloud_workspace_id, member_id)`
(re-invite upserts), indexed by `member_id` (shared-with-me). `revoked_at IS NULL` = active.

## REST surface (capability- and tenant-gated)
```
POST   /workspaces/:wid/cloud-workspaces                      create (workspace member) -> 201
GET    /workspaces/:wid/cloud-workspaces                      list owned + shared-with-me
GET    /workspaces/:wid/cloud-workspaces/:id                  get        (read cap)
POST   /workspaces/:wid/cloud-workspaces/:id/sleep            sleep      (write cap) -> { status }
POST   /workspaces/:wid/cloud-workspaces/:id/wake             wake       (write cap) -> { status, snapshotId }
GET    /workspaces/:wid/cloud-workspaces/:id/collaborators    list       (read cap)
POST   /workspaces/:wid/cloud-workspaces/:id/collaborators    invite     (propagate) { memberId, capability } -> 201
DELETE /workspaces/:wid/cloud-workspaces/:id/collaborators/:memberId  revoke (propagate)
```
**Mirroring transport is behind a seam (like #25's `SandboxProvider`).** The hermetic, fully
tested sync core is `CloudWorkspaceManager.syncToLocal(cw, source, sink, runSetup)`: it diffs a
`MirrorSource` (cloud) against a `MirrorSink` (local) and runs setup once. A production
`MirrorSource` backed by a session snapshot is a **documented follow-up** behind the seam — so
this PR carries the mechanics + tests with **no cloud spend**, exactly as #25 left real Vercel
calls behind a provider. The integration test injects an in-memory source + a real temp-dir
`FsMirrorSink` to prove the mirror + setup-once flow end to end.

## Realtime (reuse #5)
- **Client commands:** `{ type: "watch", cloudWorkspaceId }`, `{ type: "unwatch", cloudWorkspaceId }`.
- **Server events:** `{ type: "watching"|"unwatched", cloudWorkspaceId }`,
  `{ type: "workspace_presence", cloudWorkspaceId, memberId, status: "joined"|"left" }`,
  `{ type: "access_revoked", cloudWorkspaceId }`.
- **Gating:** `watch` checks active collaborator (or owner) access; otherwise `forbidden`.
- **Revoke cuts access:** the revoke route publishes `access_revoked` targeted at the member; the
  gateway drops that member's watch and sends them the `access_revoked` event.

## Commands
```
Typecheck: pnpm -C platform typecheck
Lint:      pnpm -C platform lint
Unit test: pnpm -C platform test          (or: pnpm --filter @reload/server test)
Integration: pnpm --filter @reload/server test:integration   (real Postgres/Redis)
Build:     pnpm -C platform build
Migrate:   pnpm --filter @reload/server db:migrate
Demo:      platform/scripts/demos/32-cloud-sync-sharing.sh
```

## Project structure
```
apps/server/drizzle/0032_cloud_sync_sharing.sql(+.down.sql)   migration
apps/server/src/db/schema/cloud-workspaces.ts                 drizzle tables
apps/server/src/db/repositories/cloud-workspaces.ts           cloud workspace CRUD
apps/server/src/db/repositories/cloud-workspace-collaborators.ts  collaborator CRUD
apps/server/src/workspace/sync.ts                             mirror protocol + sinks
apps/server/src/workspace/manager.ts                          CloudWorkspaceManager
apps/server/src/workspace/default.ts                          repo-backed manager factory
apps/server/src/routes/cloud-workspaces.ts                    REST routes
apps/server/src/auth/access.ts                                +requireCloudWorkspaceCapability
apps/server/src/realtime/{protocol,bus,gateway}.ts            +watch/presence/revoke
apps/server/test/unit/{cloud-sync,cloud-workspace-manager,cloud-workspace-access,realtime-protocol}.test.ts
apps/server/test/integration/cloud-sync-sharing.test.ts
docs/adrs/0032-cloud-sync-sharing.md                          ADR
scripts/demos/32-cloud-sync-sharing.sh                        demo
```

## Code style
Match the surrounding server code: explicit interfaces for seams (tests inject fakes), thin
routes that delegate to repos + a single access helper, no `any`, `.js` import suffixes, JSDoc on
exported surfaces explaining *why*. Example (the sync core):
```ts
/** Apply the cloud manifest to the local sink: write changed/new files, remove deleted ones. */
export async function mirror(source: MirrorSource, sink: MirrorSink): Promise<SyncResult> {
  const [remote, local] = await Promise.all([source.manifest(), sink.manifest()]);
  const { toWrite, toRemove, unchanged } = diffManifests(remote, local);
  for (const path of toWrite) await sink.write(path, await source.read(path));
  for (const path of toRemove) await sink.remove(path);
  return { written: toWrite, removed: toRemove, unchanged };
}
```

## Testing strategy
- **Unit (hermetic, no DB — `pnpm test`):**
  - `cloud-sync`: `diffManifests` classifies add/update(by hash)/delete/unchanged; `mirror`
    applies them to an in-memory sink; `FsMirrorSink` writes/removes a real temp directory.
  - `cloud-workspace-manager`: setup runs **exactly once** across two mirrors; `sleep`→`wake`
    round-trips and wake returns the retained snapshot; `sweepIdle` sleeps only idle workspaces.
  - `cloud-workspace-access`: `effectiveCloudWorkspaceCapability` (owner=propagate, active
    collaborator=its level, revoked/none=null) + the #9 ladder.
  - `realtime-protocol`: `watch`/`unwatch` parse; bad payloads rejected.
- **Integration (real Postgres/Redis — `test:integration`):** `cloud-sync-sharing`:
  1. mirror a cloud workspace's files to a temp dir and assert setup ran once (second sync: not);
  2. owner invites a collaborator → collaborator reads the workspace and a WS `watch` succeeds +
     `workspace_presence` is observed; **revoke** → collaborator's `GET` is 403 and they receive
     `access_revoked`;
  3. record a snapshot, `sleep`, `wake` → status `active` + the snapshot id returned;
  4. cross-tenant access to another tenant's cloud workspace is a 404 (IDOR).
- **Demo** (`scripts/demos/32-cloud-sync-sharing.sh`, recorded as the PR video): create a cloud
  workspace, mirror files locally + setup once, invite a collaborator, revoke (access cut), sleep
  + wake (resume).

## Boundaries
- **Always:** keep cloud workspaces tenant-isolated (cross-tenant = 404); reuse the #9 ladder and
  #5 bus rather than inventing new authority; run setup at most once per workspace; keep secrets
  out of synced files and never log file contents; default the idle sweep OFF; write the failing
  test first; attach the demo video.
- **Ask first:** turning the idle sweep on by default; adding a real cloud transport dependency
  loaded in CI; any bi-directional/CRDT sync; changing the #25 snapshot contract.
- **Never:** sync a secret into a local file or a log; let a revoked collaborator keep REST or
  live access; leak a cloud workspace across tenants; merge without approval + video.

## Success criteria
1. Files mirror cloud→local by hash diff and setup runs exactly once (unit + integration).
2. A scoped collaborator sees the live shared workspace; revoke cuts REST + live access
   (integration).
3. A slept workspace retains its snapshot and wakes to resume from it (unit + integration).
4. Cross-tenant access is impossible (IDOR integration test).
5. `pnpm -C platform typecheck && lint && test && build` green; integration green.
6. ADR-0032 + this spec + demo `docs/demos/32-cloud-sync-sharing.mp4`; PR links #55; **not** merged.

## Open questions
- None blocking. The local mirror trigger is intentionally client-driven (the server exposes the
  manifest); a server-push sync daemon is a deferred follow-up.
```
