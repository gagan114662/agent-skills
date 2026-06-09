# ADR-0036: Custom Subagents / Agent Personas (@code-reviewer)

- **Status:** Accepted (Gagan approved defaults-and-go — issue #59; merged on the video)
- **Date:** 2026-06-09
- **Context issue:** [#59](https://github.com/gagan114662/agent-skills/issues/59) (Feature phase 4 —
  Real execution & Conductor parity)
- **Builds on:** [ADR-0003](0003-auth-identity.md) (members: humans & agents are interchangeable
  participants; agent tokens), [ADR-0006](0006-threads-mentions.md) (mentions + one-level threads),
  [ADR-0009](0009-registry-rbac.md) (the read<write<propagate capability ladder + agent deactivation),
  [ADR-0012](0012-acp-a2a.md) (A2A handoff), [ADR-0025](0025-cloud-execution.md) (AgentRuntime /
  SessionManager / AgentJob), [ADR-0027](0027-real-agent-harness.md) (the real Claude Code harness
  behind a config flag)

## Context
Conductor lets a workspace define **custom subagents / agent personas** — code-reviewer, test
automation, etc. — and invoke one inside a session (e.g. `@code-reviewer`). We already had A2A handoff
(#12): an agent can create a task assigned to another agent. What we lacked was a **user-defined,
@-mentionable** subagent with its **own instructions and tool scope**, runnable on demand with its
result returned into the conversation.

The pieces to build it already existed and should be **reused, not re-invented**: the real harness
(#50) runs an agent from a task; the `SessionManager` (#25) runs it server-side and streams its output
into a channel as an agent member; mentions (#6) already map `@handle` → member; and the #9 capability
ladder already governs who may do what in a channel. A persona is therefore not a new execution
engine — it is a **named bundle of (system prompt + tool ceiling)** attached to an agent member, plus
a thin, well-gated path to launch it.

The hard part is **non-escalation**: a subagent must not become a privilege-escalation vector. The
guiding decision is that a persona runs **as its own identity**, bounded by the **existing** RBAC
ladder — so adding subagents adds **no new authority**.

## Decisions

1. **A persona is an agent member + a prompt + a tool ceiling.** `agent_personas` pairs a system
   prompt, an `allowed_tools` string[] ceiling, and an optional model with a materialized **agent
   member** (`kind='agent'`, created via the existing #3 `createAgentWithToken`). Because it is a real
   member, the persona is **@-mentionable** and flows through every existing path — mentions, channels,
   sessions, A2A — for free. `agent_id` is kept so deactivation reuses #9 `deactivateAgent`. Handles
   are unique per workspace.

2. **Invoking runs the persona AS its own member, via the existing SessionManager.** There is no new
   runtime. Invocation calls `SessionManager.launch({ agentMemberId: persona member, … })`. The
   session streams its output into the channel as the persona and persists a session row — identical
   to #25, so "close the laptop, the subagent keeps working" holds for personas too.

3. **The persona prompt + tool ceiling reach the harness via env, never argv.** The harness command is
   still fixed by config and task-agnostic; `LaunchInput` gained an optional `harnessEnv` that the
   manager merges into the job env alongside `AGENT_TASK`. The `claude-code` harness gained two
   **env-gated** flags (`${AGENT_APPEND_SYSTEM_PROMPT:+--append-system-prompt …}` and
   `${AGENT_ALLOWED_TOOLS:+--allowedTools …}`) so persona config is injected exactly like the task —
   double-quoted env references inside `bash -lc`, injection-safe by construction. Non-persona sessions
   leave the vars unset and the flags vanish, so behavior is unchanged (the demo harness ignores them).

4. **The result returns into the parent thread.** `LaunchInput` gained an optional `parentMessageId`;
   when set, the started message and every streamed line thread under the invoking @mention message
   (#6 threads are one level deep). So `@code-reviewer review this diff` gets its review back **as a
   reply on that very message**. When unset, behavior is exactly #25's (its own root message).

5. **Non-escalation is enforced by reusing the #9 ladder — no new RBAC.** A single
   `SubagentService.invoke` is the gate, and it makes four checks before launching:
   1. the channel belongs to the caller's workspace (#3 IDOR — a cross-tenant channel/persona is a 404);
   2. **invoking is delegation**, so the invoker must hold `propagate` on the channel (the same cap that
      means "may hand work to others", mirroring the A2A trust boundary);
   3. the **persona's own member** must hold `>= write` on the channel — the session runs as that
      member, so it can never act where the member itself has no grant;
   4. if bound to a message, the persona must actually be @-mentioned on it (mention-driven).
   Finally the requested tool set is resolved as `requested ∩ allowedTools` — a **narrow-only** ceiling,
   so an invoker can never widen a persona's tools. The service is pure-dependency-injected and fully
   unit-tested; the route is a thin adapter that maps its result to HTTP.

6. **Tool scope is enforced at the harness boundary; channel/privilege scope at the ladder.** For this
   issue, `allowed_tools` is passed to the agent process via `--allowedTools` (the harness restricts the
   tools it may use). Promoting tools to first-class #9 RBAC resources (`resource_type='tool'`) is a
   documented follow-up; the channel-membership + propagate gates already make the **privilege**
   guarantee independent of the harness.

7. **A built-in `code-reviewer` ships as the reference, seeded idempotently.** Built-ins are ordinary
   personas with no special authority; `seedBuiltinPersonas` skips any handle that already exists, so
   re-seeding never duplicates or rotates a token.

## Consequences
- A workspace can define an `@code-reviewer` (or any persona) once and any member who can `propagate`
  in a channel can summon it there; the persona reviews the diff and replies in-thread, running scoped
  to its tools — proven end-to-end by an integration test whose harness echoes the env it received
  (`tools=Read,Grep`, the persona prompt) and posts it threaded under the invoking message.
- A subagent **cannot escalate privileges**: it runs as its own member (bounded by that member's
  grants), delegation requires `propagate`, the persona must be permitted in the channel, a cross-tenant
  persona is invisible (404), and requested tools can only narrow — each covered by a test.
- Default behavior is unchanged: no persona env → the harness command is byte-for-byte #25/#50's; the
  new `LaunchInput` fields default off, so every existing session path and test is unaffected.
- One new table (`agent_personas`), one new module (`subagents/`), one new route group; no new runtime,
  no new auth, no new capability type.

## Security
- **Runs as its own identity.** The launched session's `agentMemberId` is the persona's member; all
  downstream checks are bounded by that member's grants. Invocation cannot grant a persona access it
  lacks.
- **Delegation gate.** Invoking requires `propagate` on the channel; a read/write-only caller is 403.
- **Persona-scope gate.** The persona's member must hold `>= write` on the channel; otherwise 403 — an
  invoker cannot steer a persona into a channel it has no business in.
- **Narrow-only tools.** `resolveToolScope` returns a subset of `allowed_tools`; a request for tools
  outside the ceiling is dropped, never granted (unit-tested as a non-widening property).
- **Injection-safe config.** Prompt + tools reach the harness only via env (`AGENT_APPEND_SYSTEM_PROMPT`,
  `AGENT_ALLOWED_TOOLS`), double-quoted like `AGENT_TASK`; tool names are validated to `/^[A-Za-z0-9_-]+$/`
  and handles to a mention-token charset at define time (defense in depth).
- **No secrets in personas.** A persona carries only a prompt, tool names, and an optional model;
  secrets stay on the #25 `SecretsResolver` path and are redacted from the persona session's streamed
  output by the same `makeRedactor` path as every session.
- **Tenant isolation + deactivation.** Every persona read is workspace-scoped; deactivation reuses #9
  `deactivateAgent` (blocks auth + revokes tokens), after which the persona stops resolving as a member
  (un-mentionable) and 404s on invoke.

## Alternatives considered
- **A new per-persona execution runtime:** rejected — the #25 SessionManager + #50 harness already run
  an agent from a task and stream it into a channel; a persona is data on top, not a new engine.
- **Run the persona as the invoker's identity (impersonation):** rejected — it would make a subagent a
  trivial privilege-escalation vector. Running as the persona's own member is the entire safety story.
- **Inject persona prompt/tools as argv:** rejected — argv interpolation of free-form text is an
  injection surface; env (the existing `AGENT_TASK` contract) is injection-safe and keeps `harnessSpec`
  task-agnostic.
- **A new `resource_type='tool'` RBAC table now:** deferred — the channel + propagate gates already
  deliver the privilege guarantee; first-class tool RBAC is additive and can land later without
  changing this model.
- **Auto-fire a subagent on every @mention:** deferred to the #17 autonomy engine — this issue ships
  the deterministic, gated invoke path the engine would call, not an implicit trigger.
- **A marketplace of shared personas:** out of scope per #59 — personas are per-workspace.

## Follow-ups (deferred)
- Wire persona invocation into the #17 autonomy engine so an @mention can auto-dispatch.
- First-class tool RBAC (`resource_type='tool'`) layered on the same #9 ladder.
- A web UI (#18/#51) for defining/invoking personas over these same routes.
- Synchronous nested sub-subagent invokes (a persona invoking a persona); A2A handoff already covers
  the async case.
- Thread persona `harnessEnv` into the SandboxRuntime backend (the seam already carries it).
