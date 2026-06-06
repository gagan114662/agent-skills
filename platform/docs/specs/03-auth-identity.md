# Spec: Reload Platform — Auth & Identity (Issue #3)

> Implements [#3](https://github.com/gagan114662/agent-skills/issues/3). Phase 0 — Foundation. Depends on #1, #2.
> Lifecycle: **DEFINE** artifact (`spec-driven-development`). No code until approved.
> ⚠️ **Trust boundary.** This issue should get a human/`security-and-hardening` review — recommend exempting its PR from auto-merge even with green gates.

## Objective
**What:** Authenticate the two kinds of workspace participants — **humans** (browser sessions) and **agents** (scoped API tokens) — and resolve every request to a `member` in a workspace. Plus membership: invite a human, register an agent.

**Why:** Everything after this (channels #4, realtime #5, RBAC #9, MCP #10, approvals #13) needs to know *who is calling* and *in which workspace*. #2 gave us `users`/`agents`/`members` structurally; #3 makes them authenticable.

**Who:** Every endpoint/WS connection from #4 onward calls the auth middleware defined here.

### Acceptance criteria
- A human can authenticate and receive a session; authenticated requests resolve to their `member`.
- An agent token authenticates HTTP **and** WebSocket calls, scoped to one workspace; resolves to the agent `member`.
- Tokens/sessions are **revocable**; revoked credentials are rejected immediately.
- `GET /me` returns the resolved identity `{ workspaceId, memberId, kind, displayName }` or 401.
- Reusable `requireAuth` middleware usable by all later routes (HTTP + WS).
- Secrets are **hashed at rest** (no raw tokens/passwords in the DB or logs).

### Out of scope (deferred)
- Role permissions read/write/propagate (#9). #3 only answers *who/where*, not *what they may do*.
- Rate limiting / brute-force lockout / full audit log (note hooks; harden later).
- Production email/OAuth provider wiring (interface now; dev provider shipped — see Decision 1).

## Schema additions (migration `0001_auth.sql` + `.down.sql`)
- `users`: add `password_hash text` (nullable — OAuth/magic-link users won't have one).
- `sessions`: `id uuid pk, user_id → users (cascade), token_hash text unique, expires_at timestamptz, created_at`. Server-side + revocable (Decision 2).
- `agent_tokens`: `id uuid pk, agent_id → agents (cascade), workspace_id → workspaces (cascade), token_hash text unique, name text, created_at, revoked_at timestamptz null`. Multiple per agent, each revocable (Decision 3).

(Down drops the new tables/column. Same runner as #2.)

## Endpoints (this issue)
```
POST /auth/signup      { email, password, displayName, workspaceSlug } → sets session cookie
POST /auth/login       { email, password }                            → sets session cookie
POST /auth/logout                                                      → revokes current session
GET  /me                                                               → resolved identity | 401
POST /workspaces/:id/agents        (human-authed) { name, framework }  → creates agent + member + returns token ONCE
POST /workspaces/:id/agents/:aid/tokens/:tid/revoke (human-authed)     → revokes an agent token
```
Agents authenticate other endpoints with `Authorization: Bearer rld_agt_<secret>`.

## Auth resolution (the reusable core)
`requireAuth(req)` resolves identity in priority order:
1. `Authorization: Bearer rld_agt_…` → hash → look up non-revoked `agent_tokens` → agent member.
2. Session cookie → hash → non-expired `sessions` → human member (for the requested workspace).
→ attaches `{ workspaceId, memberId, kind, displayName }` or throws 401. Shared by HTTP routes and the WS gateway (#5).

## Testing strategy
- **Unit:** token generation/hashing (format, constant-time compare), middleware identity resolution with mocked repos.
- **Integration (real Postgres):** signup→login→`/me` (human); register agent→`/me` with Bearer (agent); **revoke→rejected (401)**; expired session rejected. Runs in the existing `integration` CI job.

## Boundaries
- **Always:** hash tokens/passwords at rest (argon2id for passwords, SHA-256 for opaque tokens); show an agent token **once** at creation; constant-time compare; `HttpOnly`+`SameSite=Lax` cookies (`Secure` in prod); scope every agent token to one workspace.
- **Ask first:** changing the session/token model; adding an OAuth/email provider (external dep + secrets); touching #2 tables beyond the listed additions.
- **Never:** log or return raw secrets after issuance; store plaintext passwords/tokens; merge an auth PR on green gates alone without a human/security review; cross-tenant identity resolution.

## Success criteria
1. `POST /auth/signup` + `/auth/login` set a working session; `GET /me` returns the human member.
2. Registering an agent returns a Bearer token once; using it on `GET /me` returns the agent member.
3. Revoking a token/session → subsequent use returns **401** (proven in a test + the video).
4. Migration `0001` up/down clean; integration tests green in CI.
5. No raw secret appears in the DB or logs (verified).
6. **Video proof** `platform/docs/demos/03-auth-identity.mp4` (human login→/me, agent token→/me, revoke→401) + ADR-0003.

## Open Questions (need your input before PLAN)
1. **Human login provider now.** Recommend a **dev email+password provider** (argon2id-hashed) behind a `LoginProvider` interface, with magic-link/OAuth as later adapters — so #3 ships the auth *framework* + a demoable login without standing up email/OAuth infra. OK, or do you want GitHub OAuth / magic-link wired now?
2. **Session strategy.** Recommend **server-side opaque sessions** (sessions table, token hashed, revocable) over stateless JWT — because the acceptance criteria require *immediate revocation*. Agree?
3. **Agent token format/storage.** Recommend opaque `rld_agt_<base64url-32B>`, shown once, stored as **SHA-256 hash**, multiple per agent, each revocable. OK?
4. **Password hashing.** Recommend **argon2id** (`@node-rs/argon2`, prebuilt binaries) over bcrypt. OK?
5. **Auto-merge exemption.** Recommend this auth PR is **NOT** auto-merged on green gates — gets a human/`security-and-hardening` review first. Confirm?

Reply with approval (+ overrides), or **"use defaults and go"** (I'll still hold the PR for explicit security review per Q5 unless you say otherwise).
