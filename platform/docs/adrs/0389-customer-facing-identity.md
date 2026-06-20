# ADR-0389: Customer-facing identity — a "face that sells" the fleet presents on outbound comms

- **Status:** Accepted (slice 1 — pure resolver + config block + read route — shipped in PR for #389)
- **Date:** 2026-06-19
- **Context issue:** [#389](https://github.com/gagan114662/agent-skills/issues/389) — outbound, customer-facing
  touchpoints (emails, landing pages, social, outreach) currently show up as an anonymous bot. To be
  credible to a customer the fleet needs ONE stable person to present as: a consistent display name +
  avatar (face) + optional voice profile + tagline — a "face that sells".
- **Builds on:** [ADR-0371](0371-named-department-roster.md)/#371 (the existing display-only persona
  identity — name/handle/color, identity-only, NO action path; this extends the same concept to a
  customer-facing face+voice), [ADR-0386](0386-attributed-revenue-ledger.md)/#386 (the default-OFF,
  owner-workspace-first `attribution` config block whose 5+2+1 shape this mirrors exactly),
  [ADR-0200](0200-premortem-panel.md) (standing rails — content is DATA, no money path, owner-first).

## Context

The fleet can already coordinate, draft, and (through the #13 gate) send. What it lacks is a consistent
**customer-facing identity** to present *as* on those outbound surfaces. Today every touchpoint is
faceless. A credible founder-style face — name + avatar + voice — is the difference between "an anonymous
automation emailed me" and "a person reached out".

This is purely an **identity/display** problem. It is NOT a sending problem: the send/publish machinery
(connectors, #13 approval gate) already exists and is unchanged. We only need a place to store and resolve
the presented face, fail-closed and owner-first, so byte-for-byte default behavior is untouched.

## Decision

Add a default-OFF, owner-workspace-first `customerIdentity` config block and a pure resolver that returns
the sanitized identity for the owner workspace — and a thin read route to surface it.

1. **Config (5+2+1).** `customerIdentitySchema` (`enabled?`, `ownerWorkspaceId?`, `founderName?`,
   `avatarUrl?`, `voiceProfileId?`, `tagline?`) + root key + `ResolvedConfig` field + `CONFIG_DEFAULTS`
   (`{}`) + type export; layers **replace-merge** (a higher/owner layer fully owns the block, so a lower
   layer can't flip the presented face on) + default fill; loader env opt-in
   (`RELOAD_CUSTOMER_IDENTITY_ENABLED` / `_OWNER_WORKSPACE_ID`, plus optional `_FOUNDER_NAME` /
   `_AVATAR_URL` / `_VOICE_PROFILE_ID` / `_TAGLINE`). Var unset ⇒ no block ⇒ no identity presented.

2. **Pure resolver** — `apps/server/src/identity/customer-identity.ts`:
   `resolveCustomerIdentity(cfg, workspaceId): CustomerIdentity | null`. Returns the identity ONLY when the
   flag is on AND the caller is the named owner workspace (fail-closed: off / named-nobody / non-owner ⇒
   `null`). PURE — no clock, no IO. Every free-text field (`founderName`, `tagline`, `voiceProfileId`) is
   sanitized for display per #200 (C0/C1 control chars stripped, whitespace collapsed, length capped); the
   `avatarUrl` is validated as a well-formed absolute http(s) URL or omitted (`null`). A `javascript:` /
   `data:` / relative URL is dropped, not presented. With no presentable name there is no credible face, so
   the resolver returns `null`.

3. **Read route** — `GET /me/customer-identity` (registered in `app.ts`), `/me/*`-scoped to the caller's
   workspace. Returns `{ identity }` when active, else `409` (opt-in surface, mirroring `/me/attribution`).
   Read-only; no #13 gate (reading a display value is not money).

## Boundaries — identity/display ONLY, no new action path

- **No new action.** Resolving an identity authorizes **nothing**. Every real outbound send/publish still
  flows through the existing #13 approval gate and the existing connectors. There is no new #13 action, no
  money action, no irreversible action, and no migration (the identity lives in layered config, not a
  table).
- **#200.** The presented fields are owner-config, but still untrusted on display: sanitize every free-text
  field, validate the avatar URL shape, omit anything malformed. The annotation/content is DATA, never an
  instruction.
- **Truthful-AI disclosure.** The presented identity must remain **truthful about being an AI agent**
  wherever disclosure is required. This block stores and resolves a face; it never licenses impersonation.
  Downstream surfaces that render the identity are responsible for the required AI disclosure.

## Default-off proof

A deployment that sets no `customerIdentity` block resolves to `{}` → `resolveCustomerIdentity` returns
`null` → `GET /me/customer-identity` answers `409`. No surface presents a face. Prod is byte-for-byte
unchanged until the owner opts the named workspace in.

## Follow-ups (out of scope for this slice)

- **Web rendering** of the resolved identity on the outbound surfaces (email from-name/avatar, landing page
  founder block, social profile) — server resolver is the contract; the web client consumes it next.
- **Actual voice synthesis** keyed off `voiceProfileId` — this slice carries the opaque id only; no
  synthesis happens here.
