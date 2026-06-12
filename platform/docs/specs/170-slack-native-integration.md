# Spec — Slack-native ipop (#170)

> Owner directive: "this needs to be an AI agent for Slack — I have been babysitting all day."
> Customers (and the owner) live in Slack; ipop must meet them there instead of making them poll a
> separate app.

## Problem

The fleet works inside the ipop web console: agents are @mentioned in department channels, approvals
queue in a panel, and the daily review lives in the Founder Console. That is a polling model — the
owner has to come to ipop. The people who need the fleet (and the owner) live in **Slack** all day.

## Goal

Bring three surfaces into the customer's own Slack workspace, **reusing** the existing audited paths
(never a new launch or approval authority):

1. **Mentions** — `@ipop scout audit site.com` in a linked Slack channel triggers the SAME
   `@mention → session` path; the agent's reply posts back in the Slack **thread**.
2. **Approvals as buttons** — a pending #13 approval DMs the owner with **Approve / Reject** buttons;
   the click round-trips to the approvals decision path **with the member's identity**; the
   append-only audit trail is preserved.
3. **Digests as DMs** — a daily fleet digest (what the agents did, what needs you, spend) arrives as a
   Slack DM, config-gated, in house voice.

## Non-goals / inbound-only posture (criterion 4)

- **No autonomous posting to customer Slack** beyond (a) agent replies in threads a human started and
  (b) the opt-in daily digest DM. The fleet never cold-posts into customer channels.
- External sends stay **#13-gated** — an agent drafting an outbound message still routes through the
  `external.send` approval gate; Slack is a notification surface, not an egress bypass.

## Design (reuse-first)

### Slack app seam — per-workspace bot token + signing secret in the vault
- `workspace_slack_connections` (one row per workspace, `workspace_id` PK — the never-pool invariant,
  identical to the #68 `workspace_agent_credentials` table). Both `bot_token` and `signing_secret` are
  stored **sealed** via `crypto/secretbox` (AES-256-GCM at rest when `AGENT_CREDENTIALS_ENC_KEY` is
  set; transparent pass-through in dev/CI). A non-reversible `bot_token_fingerprint` powers the UI's
  connected state. **Neither secret is ever returned by a status API** — they are read out only to
  verify an inbound signature or to post.
- Connect is masked write-only, mirroring "Connect Claude": `GET/PUT/DELETE /me/slack`.
- The connecting member optionally links their Slack user id (`slack_user_links`) so approval DMs and
  the digest round-trip to a real platform identity.

### Inbound webhooks — signature-verified, tenant-scoped, default-OFF
- `POST /slack/events/:wid` (Slack Events API) and `POST /slack/interact/:wid` (Block Kit
  interactivity). Both verify the Slack signature `v0=HMAC-SHA256(signing_secret, v0:${ts}:${rawBody})`
  with a constant-time compare and a 300s replay window (pure `verifySlackSignature`, mirroring the
  #98 webhook discipline but the Slack scheme — NOT a reuse of the Stripe parser). Both **503** until
  the workspace is connected. `url_verification` challenges are echoed. Events are **deduped** by Slack
  event id (`slack_events_seen`).

### Mention → session (no new authority)
- `SlackEventService.handleEvent` resolves the Slack channel → the linked ipop channel
  (`slack_channel_links`) and the Slack author → the acting member (`slack_user_links`, else the
  workspace owner), translates the bot mention into a platform `@handle` mention, and **posts that as
  a normal platform message through the existing post path** — so `deliverPostedMessage` fires the
  already-audited #123 `MarketingMentionTrigger` (→ #59 SubagentService → #96 venture gate → #71
  admission → session). The Slack thread is recorded against the root message (`slack_thread_links`).
- The agent's reply is posted by the existing `channelPoster` (agent-only). A registered post hook
  mirrors that text back to the Slack **thread** (`thread_ts`). Only agent posts mirror, so there is
  no echo loop.

### Approvals as Slack buttons (#13 preserved)
- When an action goes **pending**, a registered approval hook DMs the workspace owner a Block Kit
  message with Approve / Reject buttons carrying `rid` + `wid`. The interactivity route maps the
  clicking Slack user → member and calls the SAME `approveAndLock` / `rejectRequest` repo path that the
  REST route uses — enforcing the identical guards: **humans only**, **cannot approve your own
  request**, RBAC `canClear`, CAS lock, append-only `approval_events`. No bypass.

### Daily digest DM (config-gated, house voice)
- A pure `buildSlackDigest(input)` composes the digest from the existing Founder Console aggregate
  (fleet activity, pending approvals, spend) in house voice. A `SlackDigestEngine` (start/stop/tick,
  default-OFF interval `SLACK_DIGEST_INTERVAL_MS`, mirroring the watchdog/SRE engines) DMs it to the
  owner when `slack.digestEnabled`. Tests drive `tickWorkspace` directly.

## Invariants
- Default-OFF (`slack: {}`; every field optional). Tenant-scoped (`workspace_id` everywhere; cross-
  tenant is a 404, never a leak). Secrets sealed, write-only, never echoed. External sends stay
  #13-gated. Signature-verified webhooks. No secrets in code or logs. Migration additive `0170`. House
  copy via a `SLACK` voice block (no hardcoded strings in the web panel). Component + integration tests
  with a fake Slack transport.

See ADR-0170 for the decision record.
