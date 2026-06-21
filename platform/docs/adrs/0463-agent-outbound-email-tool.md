# ADR-0463: Agent outbound email tool — the fleet's first real outbound mouth

- **Status:** Accepted (revenue blocker #1 — #463, builds on #395)
- **Date:** 2026-06-21
- **Context task:** GitHub issue #463 — "All outbound connectors are 'Coming soon' — agents can't ship
  anything." Settings > Connections listed every execution path (Search Console+Analytics, CMS, X,
  LinkedIn, social, Google Ads) as `coming_soon`, so agents could draft but never publish/post/send.
  The MCP tool surface (#10, the "reload" server) was **internal-only**: agents could post in-channel
  but had **no tool to reach anyone outside ipop's own site**, contradicting "agents that actually ship."
- **Builds on:** ADR-0013 (the #13 approval gate + executor registry), ADR-0189 (the `external.send`
  acquisition dispatcher — the seam where a real email/ads/social send leaves the building), ADR-0268
  (the Postmark ESP provider + always-gated live send), ADR-0200 (premortem rails — a sent email is
  irreversible, untrusted external content), ADR-0010 (the reload MCP server agents act through).

## Context

The whole real-send machinery already existed but had **no agent entry point**. An approved
`external.send` of `kind: "email"` already routes — through the suppression / CAN-SPAM-footer /
domain-warmup guards — to the connected Postmark ESP (#189/#268), or records-only with no network
egress when no ESP is wired. What was missing was a tool an agent could call to *initiate* that path,
and the guarantee that initiating it always pauses for the owner.

A real email is the most irreversible acquisition surface (premortem #200 §4: a sent email is in a
stranger's inbox forever and burns sender reputation). Under the #243 money-only policy, a non-money
`external.send` would *auto-approve* — so we cannot ride the generic auto-approve route for an outbound
email. Outbound sends are structurally always-gated (the same precedent as `outreach.send` and
`email.live_send`).

## Decision

Add a single agent-callable MCP tool, `send_outbound_email`, that **always parks a PENDING #13 owner
approval** showing the exact recipient + subject + body — it never sends in-tool. On approval, the
existing approve path runs the already-wired acquisition registry (`buildAcquisitionRegistry`), so the
email is delivered for real when the owner has connected an ESP, and recorded-only otherwise. This
reuses the existing real-send lever rather than adding a new one.

- **Pure module** (`email/agent-outbound.ts`, fully unit-tested): `validateOutboundEmail` (one valid
  recipient, non-empty bounded subject/body, normalized/trimmed); `buildOutboundEmailAction` (shapes
  the existing `external.send` payload — `kind: "email"`, `recipients`, `target` for the #151 egress
  allowlist, `subject`, `body`); and `createOutboundEmailSubmitter(identity, log, deps)` — validates,
  then ALWAYS `createRequest({ status: "pending", actionType: "external.send" })` and best-effort
  notifies the workspace's human reviewers. The repo/notify IO is injected so the submitter is testable
  offline. There is no input that makes it auto-approve or execute.
- **Tool** (`mcp/server.ts`): `send_outbound_email({ to, subject, body })` calls the submitter (an
  injectable `outboundEmail` dep on `McpServerDeps`, defaulting to the identity-bound real submitter)
  and returns `{ status: "pending_approval", requestId, summary, message }`. The copy is customer-safe —
  it tells the agent the email is queued for an owner's yes and nothing leaves until then.

## Consequences

- **One real end-to-end outbound channel is live behind approval** (the issue's acceptance): an agent
  can reach a real person outside ipop — queued → owner-approved → sent for real (or recorded-only until
  an ESP is connected). The `external.send` → Postmark path is unchanged; this only adds the entry point.
- **No autonomous send, ever.** Every outbound email is a PENDING #13 request regardless of policy —
  the structural always-gate, matching `outreach.send` / `email.live_send`.
- **No money path, no new action type, no new executor.** The recipient + content are untrusted DATA on
  the payload (#200 §6); the dispatcher's in-code compliance/warmup guards still run at execution.
- The `coming_soon` consumer connectors (Google, website, X, LinkedIn, social, Google Ads) are unchanged
  — they are still rolling out. The "agents that actually ship" claim is now honest for email.
