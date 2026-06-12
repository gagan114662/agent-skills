# ADR-0170: Slack-native ipop — the fleet works inside the customer's Slack

- **Status:** Accepted (Gagan approves defaults-and-go; **video gate waived by the owner** — issue #170)
- **Date:** 2026-06-12
- **Context issue:** [#170](https://github.com/gagan114662/agent-skills/issues/170) — "this needs to be
  an AI agent for Slack — I have been babysitting all day." Customers (and the owner) live in Slack;
  ipop must meet them there instead of requiring them to poll a separate app.
- **Builds on:** [ADR-0068](0068-subscription-first-agent-auth.md) (the per-tenant sealed `crypto/secretbox`
  vault + masked write-only "Connect Claude" pattern), [ADR-0013](0013-approval-gates.md) (the human gate +
  `approveAndLock`/`rejectRequest` + append-only `approval_events`), [ADR-0043](0043-revenue-rails.md)
  (the pure `node:crypto` signed-webhook + raw-body plugin-scope discipline), #123 (the audited
  `@mention → SubagentService → venture gate → admission → session` path + the registered fan-out trigger),
  [ADR-0008](0008-notifications.md) (the `NotificationTransport` seam), #104 (the Founder Console
  aggregate the digest reads), [ADR-0035](0035-config-layering.md) (layered default-OFF config).
- **Spec:** [170-slack-native-integration.md](../specs/170-slack-native-integration.md).

## ⚠️ Decision first — Slack is a new SURFACE over existing authority, never a new authority

The fleet already has audited paths for everything Slack needs: launching a session from an @mention,
clearing an approval, and aggregating a daily review. The whole feature is therefore an **adapter**: it
translates Slack events into the existing post/approve paths and mirrors the existing outputs back into
Slack. It adds **no** new way to launch a session, **no** new way to clear an approval, and **no** new
egress that isn't already #13-gated. Everything is **default-OFF**, **tenant-scoped**, and
**signature-verified**. The alternative — a parallel Slack-only launch/approval path — would duplicate
(and inevitably drift from) the security-critical gates. We refuse that.

## Decisions

### 1. The Slack credentials live in the #68 sealed vault, masked write-only (no new secret mechanism)
`workspace_slack_connections` has `workspace_id` as its PRIMARY KEY (one row per tenant — the same
never-pool invariant as `workspace_agent_credentials`). `bot_token` and `signing_secret` are stored
**sealed** via the existing `crypto/secretbox` (`seal`/`open`, AES-256-GCM when `AGENT_CREDENTIALS_ENC_KEY`
is set, transparent pass-through otherwise). A non-reversible `bot_token_fingerprint` is the only
secret-derived value an API ever returns. `getSlackStatus` returns connected/fingerprint/team — **never**
a secret; the decrypted secrets are read out only by the signature verifier and the poster. Connect is
`GET/PUT/DELETE /me/slack`, mirroring `/me/agent-credentials`.

### 2. Inbound webhooks verify the Slack signature with a parallel pure helper (not the Stripe parser)
`slack/verify.ts#verifySlackSignature` recomputes `v0=HMAC-SHA256(signing_secret, v0:${ts}:${rawBody})`
over the **raw** body, compares constant-time, and rejects a timestamp outside a 300s window (replay).
It mirrors the #98 discipline but Slack's scheme — sharing the *discipline*, not the code. Both routes
(`/slack/events/:wid`, `/slack/interact/:wid`) register a raw-body parser in an encapsulated plugin
scope (the rest of the app keeps JSON parsing), **503** until the workspace is connected, echo the
`url_verification` challenge, and **dedupe** by Slack event id (`slack_events_seen`).

### 3. A mention is posted as a normal platform message — the existing trigger does the launch
`SlackEventService` resolves the Slack channel → linked ipop channel and the Slack author → acting
member (linked, else the workspace owner), translates `<@BOT> scout …` → `@scout …`, and posts it
through the existing post path. That fires the already-audited #123 `MarketingMentionTrigger`
(→ #59 → #96 → #71 → session). No new launch authority. The agent's reply (posted by the existing
agent-only `channelPoster`) is mirrored to the Slack thread via a registered post hook keyed on the
mention's root message id (`slack_thread_links`). Only agent posts mirror ⇒ no echo loop.

### 4. Approval buttons round-trip through the SAME `approveAndLock`/`rejectRequest` (gate intact)
A registered approval-pending hook DMs the owner a Block Kit Approve/Reject message carrying `rid`+`wid`.
The interactivity route maps the clicking Slack user → member and calls the identical repo decision path
the REST route uses, enforcing the **same** guards — humans only, cannot approve your own request, RBAC
`canClear`, CAS lock, append-only audit. The Slack button is a new *trigger* for the gate, not a new gate.

### 5. The digest is a pure builder over the #104 aggregate, sent by a default-OFF engine
`slack/digest.ts#buildSlackDigest` is pure (house voice, no IO/clock). `SlackDigestEngine`
(start/stop/tick, `SLACK_DIGEST_INTERVAL_MS` default 0 = OFF, mirroring watchdog/SRE) DMs it to the owner
when `slack.digestEnabled`. Tests drive `tickWorkspace`.

## Consequences

- **Positive:** the owner stops babysitting the console — mentions, approvals, and the daily review come
  to Slack. Zero new authority: every Slack action lands on a gate that already has tests. Secrets reuse
  the proven #68 vault. All surfaces default-OFF, so wiring this changes nothing until a workspace connects.
- **Negative / deferred:** Slack OAuth install flow (we take a bot token directly, like Connect Claude —
  an install UI is a later slice); rich Block Kit modals for editing a drafted send before approval
  (today: Approve/Reject only); per-channel digest scheduling (today: one daily owner DM). All are
  additive over these seams.
- **Migration:** additive `0170_slack_native.sql` (+ `.down.sql`), number-by-issue to dodge sibling-branch
  collisions. No change to any existing table.
