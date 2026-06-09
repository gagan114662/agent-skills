# ADR-0032: Cloud↔Local File Sync + Persistent & Shared Cloud Workspaces

- **Status:** Accepted (Gagan approves on the demo video — issue #55)
- **Date:** 2026-06-09
- **Context issue:** [#55](https://github.com/gagan114662/agent-skills/issues/55) (Feature phase 4 — Real execution & Conductor parity)
- **Builds on:** [ADR-0003](0003-auth-identity.md), [ADR-0004](0004-channels-dms.md),
  [ADR-0005](0005-realtime-messaging.md), [ADR-0009](0009-registry-rbac.md),
  [ADR-0019](0019-deploy-observability.md), [ADR-0025](0025-cloud-execution.md)

## Context
#25 gave us cloud *execution*: a session runs server-side on an `AgentRuntime`, streams into a
channel, and snapshots its filesystem at teardown. But that filesystem is **ephemeral and
single-user** — there is no way to pull it down to a laptop, no durable workspace that survives
across sessions, and no way to share a live workspace with a teammate. Conductor Cloud closed
exactly this gap: it mirrors cloud-workspace files to local (running setup on first mirror),
sleeps/archives idle cloud workspaces, and supports shared workspaces with revocable collaborator
access. This ADR adds the same three capabilities on top of #25.

## Decisions

1. **A durable `cloud_workspace` distinct from the tenant `workspace`.** The tenant is still a
   `workspace`; a **cloud workspace** is a durable filesystem environment *within* a tenant
   (`cloud_workspaces`), with a lifecycle (`active | sleeping | archived`), the latest filesystem
   `snapshot_id` (the wake/resume key), a `setup_completed` flag, an owner, and `last_active_at`.
   One tenant has many cloud workspaces. Naming them distinctly avoids overloading "workspace".

2. **Sleep/wake reuses the #25 snapshot as the resume key — no new snapshot mechanism.** #25
   already snapshots a sandbox at teardown and can resume from a `snapshotId` at provision. A
   cloud workspace stores the *latest* such snapshot; **sleep** flips the row to `sleeping`
   (retaining the snapshot), **wake** returns it to `active` and yields the snapshot id so the next
   session provisions from it. `recordSnapshot` is the hook a session teardown calls. An opt-in
   idle **sweep** (`CLOUD_SWEEP_INTERVAL_MS`, default off — like the #17 loop) sleeps workspaces
   idle past `CLOUD_IDLE_MS`, so unused environments stop consuming resources.

3. **Sync is a content-hash manifest diff behind a transport seam — like #25's `SandboxProvider`.**
   `mirror(source, sink)` diffs a `MirrorSource` (cloud) against a `MirrorSink` (local) by SHA-256
   and applies writes/removes; `CloudWorkspaceManager.syncToLocal` wraps it with **setup-on-first-
   mirror** (run a setup command once, gated by `setup_completed`). The local sink is `FsMirrorSink`
   (writes a real directory, **path-traversal-guarded** so a hostile manifest can't escape root);
   tests use an in-memory source/sink. The **production `MirrorSource` backed by a session snapshot
   is a documented follow-up** behind the seam — so this PR ships the full mechanics + tests with
   **zero cloud spend**, exactly as #25 left real Vercel calls behind a provider.

4. **Sharing reuses the #9 RBAC ladder; the owner is the implicit admin.** A
   `cloud_workspace_collaborators` row grants a member `read|write|propagate` on a cloud workspace,
   revocable via `revoked_at` (kept for audit). The **owner holds `propagate` implicitly** (no
   row). `requireCloudWorkspaceCapability` is the single access call routes make — it carries the
   #3 IDOR discipline (**a cloud workspace in another tenant, or one you neither own nor
   collaborate on, reads as 404**, never revealing existence) and the #9 ladder. Sharing is
   **collaborator-gated**, not workspace-membership-gated: being in the tenant is not enough.

5. **Revoke cuts access immediately — REST and live.** Revoking sets `revoked_at` (so the next
   request resolves to no-access → 404) **and** publishes an `access_revoked` signal on the #5 bus
   targeted at the member; the gateway drops that member's live watch and notifies them, on any
   server instance. So a revoked collaborator loses both their next REST call and their open
   socket.

6. **Live presence on a shared workspace reuses the #5 realtime path.** New `watch`/`unwatch`
   socket commands (gated by `requireCloudWorkspaceCapability`-equivalent) fan out a
   `workspace_presence` (joined/left) event over a per-cloud-workspace Redis key
   (`rt:cloudws:<id>`), with first-watch/last-unwatch edge detection — so collaborators see, in
   real time, who else is attached. No new authority and no new transport: it rides the existing
   pub/sub + gateway, exactly like #6 mentions and #8 notifications.

7. **Observability extends the #19 dependency-free registry, with cardinality discipline.**
   `cloud_workspace_sleeps_total`, `cloud_workspace_wakes_total`, `cloud_workspace_syncs_total`,
   and `cloud_workspace_files_synced_total` — **no tenant labels** (they live in logs).

8. **Secrets stay out of synced files by construction.** #25 keeps secrets env-injected and out of
   snapshots, so the file set a `MirrorSource` exposes never contains a secret; the sync layer adds
   no secret handling of its own and **never logs file contents**.

## Consequences
- A cloud workspace is durable: it can sleep to save resources and wake to resume from its
  snapshot — proven by unit + integration tests.
- A scoped collaborator can read and watch a live shared workspace; revoke cuts REST + live access
  at once — proven by an integration test over real Postgres + Redis + WebSocket.
- Files mirror cloud→local by hash diff with setup running exactly once — proven hermetically and
  end-to-end (real temp directory).
- Dev/CI run entirely on the in-memory source + a temp-dir sink, with the sweep off and no cloud
  transport loaded: **zero cloud spend**, consistent with the #25 boundary.

## Hardening note (`security-and-hardening`)
- **Access scoping:** collaborator-gated, IDOR-safe (cross-tenant / no-access = 404), #9 ladder
  enforced on every route; revoke is immediate and double-enforced (DB + live signal).
- **Secret handling:** synced files come from a secret-free snapshot; file contents are never
  logged; the redaction guarantees of #25 are unchanged.
- **Path safety:** `FsMirrorSink` confines every write/remove to its root (traversal rejected),
  so an untrusted manifest cannot write outside the mirror directory.

## Follow-ups (deferred)
- A production `MirrorSource` backed by a real session snapshot (the cloud→client transport).
- Bi-directional / CRDT sync with conflict resolution (today: one-way pull + manifest).
- Binary/delta transfer (today: whole-file on hash change).
- Multi-region placement and warm-pool wake tuning (revisit under #17).
- A web UI for the shared-workspace roster + presence (reuses the #18 client patterns).
