# ADR-0269: Echo social posting via a connect-once aggregator bridge

- **Status:** Accepted (shipped in PR for #269)
- **Date:** 2026-06-18
- **Context issue:** [#269](https://github.com/gagan114662/agent-skills/issues/269) — *"Per-platform social
  APIs are costly, rate limited and approval gated (X paid write tiers, LinkedIn partner approval, Instagram
  and TikTok business requirements). Echo should post through a connect-once aggregation layer that abstracts
  these and handles media."*
- **Acceptance:** a user connects a social account with one click and Echo publishes a post without the user
  touching any developer portal.
- **Builds on:** [ADR-0013](0013-approval-gates.md) (#13 approval queue — the owner gate),
  [ADR-0258](0258-connect-once-integrations.md) (the connect-once provider/flow this is a per-department
  follow-up of — the provider seam names *"a social aggregator for Echo (#269)"*),
  [ADR-0266](0266-hosted-publishing.md) (the draft → park → approve → execute lifecycle + dispatcher pattern
  this mirrors), [ADR-0295](0295-deliverable-delivery.md) (the approve→ship dispatcher),
  [ADR-0243](0243-money-only-approval.md) (money-only autonomy — and why #269 deliberately overrides it for an
  irreversible send), the standing premortem [#200](https://github.com/gagan114662/agent-skills/issues/200).

## Context

Echo (the social department) had no real posting path. Posting to X / LinkedIn / Instagram / TikTok directly
means a customer wrangling per-platform developer portals, paid write tiers, and partner-approval queues — the
exact friction the issue rejects. The issue's answer is a **connect-once aggregation layer**: the customer
connects ONCE (one consumer-OAuth consent through the #258 connect-once flow), and Echo drafts a post once and
the bridge fans it out to every connected network in a single call.

The standing premortem (#200) frames the hard constraints:

- **§4 reversibility — a post is IRREVERSIBLE.** A sent post cannot be un-sent (deliverability + brand cannot
  be un-rung). The premortem's rule for an irreversible action is a pre-commitment constraint or a human — never
  post-hoc review. So **every publish goes through the #13 owner approval**, drafted and queued, never
  autonomous. This *overrides* the #243 money-only default (a post is money-free, but irreversibility makes it
  owner-gated anyway — the same override #266 makes for a published page).
- **§3 production-grounded verification + §2 external receipts.** Success must touch reality: after the fan-out
  the bridge **reads back** each network's status + permalink from the aggregator's real API; a network counts
  as `published` ONLY when it returns a real external post id. A self-reported "ok" with no receipt is treated
  as `failed`, never as success.
- **§6 injection defense.** A post's body is USER DATA an agent may have folded a poisoned web read into. It is
  opaque content passed straight to the aggregator — never parsed to choose a target, add a network, or flip a
  flag. The target networks are a STRUCTURAL, allow-listed field; routing is by post id.
- **Default-OFF, owner-workspace-first** (§5 owner attention) and **no credentials / no live posting** in this
  slice — the live aggregator client is a deliberate, owner-gated follow-up.

## Decision

Build social posting as its **own module** (`src/social/`) and surface (`/me/social/*`), reusing the #258
connect-once seam for the single connection and mirroring the #266 hosted lifecycle. The aggregator bridge is
a provider seam (single connect → multi-network fan-out → read-back verify), dry-run by default. The lifecycle:

```
draftPost  ──►  requestPublish  ──►  [#13 owner approval]  ──►  executePublish  ──►  verify (read-back)
(autonomous,    (ALWAYS parks a       (the only gate;          (post-approval        (per-network permalink
 posts nothing)  pending request)      owner approves)          ONLY, fail-closed)    + external receipt)
                                                                       │
                                                                  fan out to every connected network
```

### Where each piece lives

- **`social/decide.ts` (pure):** `resolveSocialFlags` (default-OFF, owner-workspace-first — a byte-for-byte
  copy of the #266/#295 resolver); `decideSocialPost` (validates a request — reads the body ONLY for
  emptiness/length, validates the networks against the `SUPPORTED_NETWORKS` allow-list, normalizes a future
  `scheduledAt`; never parses content for routing); `buildNetworkPreviews` (the per-network preview with
  char-limit flagging); `mapFanOutToReceipts` (downgrades a "published" claim with no external id to `failed`
  — the external-receipt rule); `summarizePostStatus` (overall status from the verified receipts only).
- **`social/aggregator.ts` (the bridge):** `SocialAggregatorProvider` — one `publish` fans a post out to every
  target network; `verify` re-reads per-network status + permalinks (the production-grounded proof). The
  default `DryRunSocialAggregator` makes NO network call and never mints a real post (`live:false`, no external
  id/permalink) — an unwired deployment posts nothing real. `MockSocialAggregator` is the test/demo double.
  `createSocialAggregator` returns a live client only when one is wired (none is, in this slice).
- **`social/service.ts`:** `SocialPublishService` — the lifecycle. `requestPublish` ALWAYS parks a #13 request
  (the hard constraint — there is no autonomous publish path) and the payload is structural (post id + network
  list + schedule, never the body). `executePublish` runs ONLY from the post-approval dispatcher and is
  **fail-closed on a missing approval id**; it fans out, reads back permalinks, records the externally-grounded
  receipts, and never claims a live post for a dry-run provider. `summary` reports published counts from
  recorded receipt rows only.
- **`social/dispatcher.ts`:** `createSocialPublishDispatcher` — mirrors the #266/#295 dispatcher exactly: the
  owner's approval is the ship trigger; routing is structural (the post id off the approval payload, never the
  content); fail-closed on empty approval id / feature-OFF / missing post id.
- **`approvals/policy.ts`:** `SOCIAL_PUBLISH_POST_ACTION = "social.publish_post"` — a STRUCTURAL always-gate
  parked by the service (like `hosted.publish`). It is NOT money (not in `MONEY_ACTIONS`) and NOT in
  `IRREVERSIBLE_ACTIONS` (that list is the money-exposure metric source); the irreversibility of a post is
  enforced by the structural always-gate, not the money predicate.
- **`connections/registry.ts`:** a single customer-OAuth `social_aggregator` descriptor ("Connect your social
  accounts") — ONE consent unlocking `post_social`, the connect-once bridge the acceptance criteria demand.
- **Storage:** migration `0269_social_aggregator_bridge.sql` — `social_posts` + `social_post_results`.
  `approval_request_id` is the load-bearing proof a post only fanned out through an approval; `social_post_results`
  is the external-receipt metric source. Names are NOT `venture_`/`growth_`/`moat_`-prefixed, so the #155
  colocation gate is not tripped.
- **Config:** a new `social` block (schema.ts + layers.ts + loader.ts), default-OFF owner-first, env
  `RELOAD_SOCIAL_*` (owner marker reuses the #258 `RELOAD_MARKETING_OWNER_WORKSPACE_ID`).

### Why a single aggregator connection, not per-network connectors

The issue's whole premise is *one* connect that abstracts the per-platform mess. The registry keeps the
existing per-network `x` / `linkedin` connectors, but Echo's path is the `social_aggregator` connection: one
consent, one credential in the #192 vault, one fan-out call. That is what lets the acceptance criteria —
"connects with one click and Echo publishes without touching any developer portal" — actually hold.

## Consequences

- **Nothing posts without an explicit owner approval.** The service has no autonomous publish path; the only
  thing that fans a post out is the post-approval dispatcher, fail-closed on a missing approval id.
- **Production-grounded + injection-safe + externally-grounded** by construction (read-back verify; structural
  router that never reads the body; published metrics from recorded receipts only).
- **Default-OFF, owner-workspace-first, no live posting.** A fresh deployment posts nothing; the aggregator is
  dry-run until an owner connects a live one — the wiring is left gated for the owner to approve.
- **No metric-surface or governed table touched** → colocation stays green; numbered 0269 by issue (ADR-0099)
  to dodge sibling-workspace migration collisions.
- **Acceptance met end-to-end** (pure → service → #13 gate → dispatcher → verify): Echo drafts a post, the
  owner approves, the bridge fans it out to every connected network and reads back the live permalinks — with
  the live aggregator left as the owner-gated final wire.
