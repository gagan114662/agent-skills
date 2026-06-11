# 123 — Marketing Department Fleet

> Owner directive (live review of https://ipop.ai vs reload.chat): a fresh ipop workspace must land
> the user **inside a working marketing agency of agents** — like reload.chat's preloaded team, but
> every department is a **real** platform agent doing **real** work through the existing session
> machinery (#25/#50/#84/#96), not a demo persona. Video gate **waived by owner**.

## Goal

On a fresh workspace, seed a full marketing department: a channel per function, a named agent per
function bound to a department-scoped prompt + tool ceiling, and a welcome brief per department that
proves each agent is alive. Mentioning an agent (`@scout audit our landing page`) spawns/uses a
**real harness session** through the venture-gated launcher (kill-switch + tenant-budget aware) and
threads the result back into the channel. Anything that **leaves the building** (a social post, an
email, ad spend) stays **#13-gated, sensitive-by-default**: the agent drafts in-channel, a human
approves. The team panel lists humans + agents with department roles and live presence (#105).

## Non-goals

- No new RBAC. Reuse the #9 capability ladder and the #59 `SubagentService` security gate verbatim.
- No real outbound integrations. External sends are **recorded-only** after approval (same posture as
  #13 `external.send` and #98 billing). Wiring a real Twitter/SES/Ads call is a future ADR.
- No new launcher. Reuse `SessionManager.launch` (which already passes #71 admission) decorated by the
  #96 venture gate. No bypass of any existing guard.

## Design

Everything new lives under `apps/server/src/marketing/` plus one additive table, one route file, one
config block, and small wiring edits. The blueprint is a **pure, testable, extensible** module.

### 1. Blueprint (`marketing/blueprint.ts`, pure)

The department map — the single source of truth for which channels + agents a workspace gets, the
brand-voice copy, and which departments send externally.

| Channel     | Agent      | Role        | Sends externally? |
|-------------|------------|-------------|-------------------|
| `seo`       | `scout`    | SEO         | no (internal)     |
| `social`    | `echo`     | Social      | **yes**           |
| `content`   | `quill`    | Content     | no (internal)     |
| `email`     | `postmark` | Email       | **yes**           |
| `ads`       | `bid`      | Ads         | **yes**           |
| `analytics` | `lens`     | Analytics   | no (internal)     |
| `brand`     | `mark`     | Brand       | no (internal)     |

Plus two shared channels with no dedicated agent (every agent is a member): `general`, `launch`.

Each agent spec carries a department-scoped `systemPrompt`, a read/draft tool ceiling
(`Read, Grep, Glob, WebSearch, WebFetch` — **no send tool**, so "leaving the building" can only happen
through the #13 gate), an in-channel intro, and a welcome task. Brand voice (Innocent Drinks school:
chatty, warm, a little silly, first-person plural, one wink max, receipts over adjectives) lives in
`BRAND_VOICE`.

### 2. Seeding (`marketing/seed.ts`, injected deps → unit-testable; `marketing/default.ts` wires real repos)

`seedMarketingDepartment({ workspaceId, createdByMemberId, postWelcomeTasks }, deps)`, **idempotent**:

- ensure each channel exists (by name);
- ensure each persona exists (by handle) via `definePersona` (mints the #59 agent member + token);
- add the persona to its channel (member ⇒ `write` by default) and to the shared channels;
- grant the human creator `propagate` on every seeded channel (so they may @mention-invoke — the #59
  delegation gate);
- post each agent's brand-voice intro and the `#general` welcome message;
- when `postWelcomeTasks`, launch one welcome session per department through the venture-gated
  launcher and record a `marketing_tasks` row — the proof each agent is alive.

Re-running seeds nothing twice (channels/personas skipped by name/handle).

### 3. @mention → real session (`marketing/mention.ts`)

`MarketingMentionService.launch(identity, { channelId, messageId, task? })`:

- only fires in a marketing channel;
- resolves the personas @-mentioned on the message (`personaMentionsOnMessage`, #6/#59);
- for each, calls the **audited** `SubagentService.invoke` whose `launcher` is the venture-gated
  `SessionManager` (so launch passes the #96 gate **and** #71 admission: kill switch, tenant budget,
  concurrency). The session runs **as the persona member**, scoped to its tools, and threads its
  result back under the @mention message (existing #25/#59 behavior);
- records a `marketing_tasks` row (`kind:'mention'`) tying the channel + agent + session + message.

An admission denial (kill switch / budget) propagates to the existing app error handler → 402/429,
and **no task row is recorded**.

### 4. External sends stay #13-gated (`marketing/external-send.ts`, pure helper)

A social post / email / ad spend is an `external.send` action — **sensitive by default** (no workspace
rule needed) per `evaluatePolicy`, drafted in-channel, executed recorded-only after a human approves
(the existing #13 executor). `buildMarketingSend({ kind, summary, target?, amountCents? })` builds the
descriptor; `MARKETING_SEND_KINDS = social.post | email.send | ad.spend`; ad spend threads `amount`
so the #13 spend-threshold gate can re-gate it. No change to `approvals/policy.ts` or the executor.

### 5. Team panel (`marketing/roster.ts`, pure)

`buildMarketingRoster({ members, personas, liveSessionMemberIds })` → humans + agents with department
role and `present` (true iff the agent has a live #105 session). Surfaced read-only at
`GET /workspaces/:wid/department/roster`.

### 6. Config block (`marketing` in `config/schema.ts` + `config/layers.ts` + `marketing/caps.ts`)

`{ enabled?: boolean, seedWelcomeTasks?: boolean }`, **default OFF** (`resolveMarketingCaps`), wired
into BOTH `mergeSettings` and `mergeLayers` (the #58 allowlist — a block missing from either is
silently dropped). `enabled` gates **seed-on-signup**; the explicit seed route always works. Default
OFF ⇒ existing signup behavior unchanged.

### 7. Routes (`routes/marketing.ts`)

- `POST /workspaces/:wid/department/seed` — human-auth, idempotent.
- `GET  /workspaces/:wid/department/roster` — humans + agents + presence.
- `GET  /workspaces/:wid/department/tasks` — the durable task records.
- `POST /channels/:cid/messages/:mid/marketing` — @mention launch (venture-gated) + task record.

Signup (`routes/auth.ts`) best-effort calls the seeder when `marketing.enabled` (config-gated, wrapped
so a seed failure never breaks signup).

### Persistence

One additive table `marketing_tasks` (migration `0123`, numbered by issue to dodge sibling collisions):
`{ id, workspace_id→workspaces, channel_id→channels, department, agent_member_id→members,
session_id (soft), message_id (soft), kind CHECK('welcome','mention'), task,
status CHECK('launched','done','failed','blocked'), created_by_member_id, created_at, updated_at }`.

## Acceptance (integration, real Postgres + LocalRuntime fake harness)

1. Fresh workspace → seed → all 9 channels + 7 agents exist (roster + channel list).
2. `@scout audit …` → 202, session completes, the result threads under the message, a `marketing_tasks`
   row is recorded.
3. An `external.send` (social post draft) is **pending** (gated), never auto-executed.
4. Kill switch engaged → a marketing mention launch is denied (429) and no session is created.
5. `pnpm -C platform typecheck && lint && test && test:integration` green — existing tests unweakened.
