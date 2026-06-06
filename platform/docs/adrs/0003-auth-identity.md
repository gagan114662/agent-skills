# ADR-0003: Auth & identity

- **Status:** Accepted (Gagan approved defaults — issue #3)
- **Date:** 2026-06-06
- **Context issue:** [#3](https://github.com/gagan114662/agent-skills/issues/3)
- **Builds on:** [ADR-0002](0002-data-model.md)

## Context
Reload has two participant kinds (humans, agents) that must authenticate and resolve to a workspace `member`. Everything from #4 on depends on this.

## Decisions
1. **Dev email+password login behind a provider seam.** Ship email+password now; magic-link/OAuth are future `LoginProvider` adapters. Lets #3 deliver the auth *framework* (sessions, middleware, membership) and a demoable login without standing up email/OAuth infra.
2. **Server-side, revocable sessions.** `sessions` table stores the **SHA-256 hash** of an opaque token; cookie `rid` is `HttpOnly` + `SameSite=Lax` (+ `Secure` in prod). Chosen over stateless JWT because immediate revocation is an acceptance criterion.
3. **Agent tokens** are opaque `rld_agt_<32B base64url>`, returned **once** at creation, stored as **SHA-256 hash**, scoped to one workspace, multiple per agent, each revocable (`agent_tokens.revoked_at`). Lookups are by hash (no plaintext at rest). **Revocation is workspace-scoped** — `revokeAgentToken(tokenId, workspaceId)` only revokes a token belonging to the caller's workspace (prevents cross-tenant revoke / IDOR; fixed per review).
4. **Password hashing: argon2id** (`@node-rs/argon2`, OWASP-recommended), PHC string at rest, behind a `hashPassword`/`verifyPassword` seam.
   - This is the originally-approved default. (An earlier revision used Node's built-in `scrypt` to avoid a native dependency; reverted to argon2id per review — `@node-rs/argon2` ships prebuilt binaries for our dev/CI platforms, so there's no install risk in practice.)
5. **Identity resolution** (`resolveIdentity`): agent Bearer token first, then human session cookie → `{ workspaceId, memberId, kind, displayName }`. Shared by HTTP routes and (later) the WS gateway.

## Consequences
- **Positive:** no plaintext secrets at rest; revocation works; one resolver for humans + agents + (future) WS; no native crypto dependency.
- **Costs/risks:** a human session resolves to their *first* membership (fine while users have one workspace; multi-workspace switching is a later enhancement). `ownerUserId` on agents is left null for now (Identity carries `memberId`, not `userId`).
- **Security posture / deferred:** rate-limiting, brute-force lockout, and a full audit log are **not** in #3 — noted as follow-ups. **This PR should get a human/`security-and-hardening` review and be exempt from auto-merge** (Decision flagged in the spec).
