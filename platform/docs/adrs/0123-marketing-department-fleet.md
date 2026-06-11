# ADR-0123 — Marketing Department Fleet

**Status:** Accepted · **Issue:** #123 · **Spec:** `docs/specs/123-marketing-department-fleet.md`

## Context

reload.chat lands a new user inside a preloaded team. ipop.ai (live review) lands them on an empty
workspace. The owner wants ipop to open **inside a working marketing agency** — a channel and a named
agent per marketing function — where the agents are **real platform identities doing real work**
through the existing session machinery (#25 SessionManager, #50 harness, #84 real-session autonomy,
#96 venture gate, #105 watchdog), not scripted demo personas. Safety must not regress: anything that
leaves the building stays #13-gated.

We already have every primitive this needs:

- **#59 personas** are @-mentionable agent members with a prompt + tool ceiling, seeded idempotently
  (`seedBuiltinPersonas`) and invoked through the audited `SubagentService` (the #9 capability ladder).
- **#84/#96 launcher** runs a real harness session and is venture-gated; **#71 admission** is the
  single chokepoint enforcing kill switch + tenant budget + concurrency.
- **#13** makes `external.send` sensitive-by-default and recorded-only.
- **#105** exposes live session state for presence.
- **#58 config layering** gives us a per-tenant, default-OFF policy knob.

So #123 is **composition, not new authority**.

## Decision

1. **A pure blueprint** (`marketing/blueprint.ts`) is the single source of truth: channels, named
   agents (scout/echo/quill/postmark/bid/lens/mark), department-scoped prompts, a draft-only tool
   ceiling, brand-voice copy, and which departments send externally. Pure ⇒ unit-testable + extensible.

2. **Seeding reuses #59 + #4 + #9 repos** (`definePersona`, `createChannel`, `addChannelMember`,
   `grantCapability`) behind injected seams, idempotent by channel name / persona handle. The human
   creator is granted `propagate` on each seeded channel so they may @mention-invoke (the #59
   delegation gate). A welcome session per department, launched through the gated launcher, proves
   each agent alive and is recorded as a durable task record.

3. **The @mention trigger reuses the audited `SubagentService` gate verbatim**, with its `launcher`
   set to the **venture-gated `SessionManager`** (`gate.check` → `sessionManager.launch`). We do NOT
   add an auto-spawn into core message delivery; the trigger is an explicit route
   (`POST /channels/:cid/messages/:mid/marketing`), mirroring the existing `.../subagents` route, so
   the security path is identical and well-understood. Budget/kill safety is therefore **inherited**,
   not reimplemented — a denial throws `AdmissionError` (→ 402/429) before any task row is written.

4. **External sends are not special-cased.** A marketing send is an `external.send` action, already
   sensitive-by-default and recorded-only. We add only a pure descriptor builder; **no change to
   `approvals/policy.ts` or the executor**, so the gate and every existing approval test are
   untouched. The agents carry **no send tool** — leaving the building is only possible through the
   human-approved #13 path.

5. **One additive table `marketing_tasks`** materializes "REAL work, task records" and powers the
   roster's per-agent activity. Numbered **0123 by issue** (not a monotonic counter) to dodge
   sibling-branch migration collisions on the shared Conductor Postgres — the established convention
   (ADR-0099/0105). Soft session/message references so a task record outlives pruned history.

6. **A default-OFF `marketing` config block** gates **seed-on-signup**, wired into BOTH `mergeSettings`
   and `mergeLayers` (the #58 allowlist gotcha — a block missing from either silently drops). Default
   OFF ⇒ signup behavior is byte-identical until a deployment (ipop.ai) opts in, so existing tests are
   unweakened.

## Alternatives considered

- **Auto-spawn on every channel message** (no explicit route): rejected — it would put an
  un-audited launch inside the hot `deliverPostedMessage` path and risk runaway sessions. The explicit
  route keeps the proven `SubagentService` gate on the critical path.
- **A new `marketing.send` action type**: rejected — adding to `ACTION_TYPES` risks breaking
  array-equality assertions in existing approval tests, for no benefit over reusing `external.send`.
- **No table** (post a chat message as the "task record"): rejected — durable task records make
  "prove each agent is alive" queryable and give the roster real substance; the cost is one additive
  migration.

## Consequences

- ipop.ai sets `marketing.enabled` (managed layer) and every new workspace opens inside the agency.
- Adding a department = one entry in the blueprint; the seeder, roster, and trigger pick it up.
- Real outbound integrations remain a deliberate future ADR behind the existing #13 gate.
- The kill switch / tenant budget halt the whole fleet at the #71 chokepoint — one place, already
  tested.
