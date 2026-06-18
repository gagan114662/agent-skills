# Runbook: owner-workspace full activation (production dogfood)

> **Issue [#357](https://github.com/gagan114662/agent-skills/issues/357) · [ADR-0357](../../platform/docs/adrs/0357-owner-activation-profile.md)**
>
> Turn the **entire product ON for your own workspace only**, in production, so you can see and test
> every surface and loop end-to-end with **real actions** — while every other tenant stays
> **byte-for-byte unchanged** and every irreversible action still stops at the **#13 approval gate**.

This runbook drives the profile `platform/deploy/managed.owner-activation.example.toml`. It is the only
moving part: one managed-config file, scoped entirely to your workspace id, plus the live-provider secrets.

**What this runbook does NOT do, and what only YOU can do:** the PR that shipped this runbook changes no
live config, sets no secret, and runs no deploy. To activate you must, by hand:
**(a)** provide your **real workspace id**, **(b)** set the **secrets**, **(c)** run the **deploy**.
Nothing happens until you do all three.

---

## The safety model in one paragraph

Enabling a feature and wiring its live provider makes a real action **possible**. It never makes it
**autonomous**. Every "do-it-without-a-human" switch in the profile is pinned to its safe value, and every
money/irreversible action (`email.live_send`, `social.publish_post`, `provisioning.customer_spend` / ad
spend, `connection.connect_account`, hosted publish, prod promote, capability-token `write` mint) stays a
structural **#13 always-gate** regardless of any flag. The profile makes the path **reachable**; you still
approve each one in the decision queue.

---

## How activation is isolated to your workspace

The loader (`platform/apps/server/src/config/loader.ts`, `managedLayer`) merges a global `[settings]`
table for **all** tenants, then a per-tenant `[workspace.<id>]` table for **that tenant only**. The profile
puts **100 % of the activation under `[workspace."<OWNER_WORKSPACE_ID>".*]`** and leaves `[settings]`
**empty**. So:

| `loadConfig(...)` for | resolves to |
| --- | --- |
| your owner workspace id | fully activated |
| any other tenant id | `CONFIG_DEFAULTS` — byte-for-byte today's behavior |
| no id (server-wide reads) | `CONFIG_DEFAULTS` |

This is proven in `platform/apps/server/test/unit/owner-activation-profile.test.ts` (it loads this real
file and asserts both directions). As defense-in-depth, every owner-workspace-first feature *also* carries
`enabled = true` + `ownerWorkspaceOnly = true` + `ownerWorkspaceId = "<OWNER_WORKSPACE_ID>"`, so even a
mis-paste into the global table would still be gated to you by the resolution helpers.

---

## Prerequisites

1. **Your real workspace id.** Find it in the console URL / `/me` (`workspaceId`). You substitute it for
   every `OWNER_WORKSPACE_ID` placeholder below. It is a normal id — keep the surrounding double quotes in
   the TOML table headers (`[workspace."<id>".marketing]`).
2. **`flyctl` logged in as the `reload-api` app owner.** (See `platform/docs/runbooks/fly-deploy.md`.)
3. **A decision on phasing.** Bring features up in the three phases below, verifying each before the next —
   do **not** flip everything at once.

> Secret **values** below are PLACEHOLDERS. Never paste a real secret into this file, a commit, or a chat.
> `flyctl secrets set` stores the value on the Fly app; `flyctl secrets list` prints names + digests only.

---

## Step 1 — set the live-provider secrets (`flyctl secrets set`)

Set only the secrets for the phase you are bringing up. Provider **tokens never live in the managed
TOML** — the TOML carries non-secret flags + secret-var *names*; the values live on the Fly secret path or
the #192 sealed vault (connected once via the in-app onboarding flow).

```bash
# --- Phase 1 (coordination/UI/observability) — credentials are optional ---
# Slack digest (optional; until set, the Slack surface is coming_soon):
flyctl secrets set SLACK_BOT_TOKEN='xoxb-PLACEHOLDER' SLACK_SIGNING_SECRET='PLACEHOLDER' -a reload-api
# Self-healing-flywheel issue filing + real-world site publish (optional):
flyctl secrets set GITHUB_TOKEN='ghp_PLACEHOLDER' -a reload-api
# Reliability email paging (optional; status page + incidents work without it):
flyctl secrets set RELIABILITY_SMTP_URL='smtps://PLACEHOLDER' -a reload-api

# --- Phase 3 (real-action connectors) — set ONLY before the matching connector ---
# Billing (live Stripe revenue rails):
flyctl secrets set BILLING_PROVIDER='stripe' \
  STRIPE_SECRET_KEY='sk_live_PLACEHOLDER' STRIPE_WEBHOOK_SECRET='whsec_PLACEHOLDER' -a reload-api
# Email live send (Postmark) — the unsubscribe HMAC + Postmark server token:
flyctl secrets set EMAIL_UNSUBSCRIBE_SECRET="$(openssl rand -hex 32)" \
  POSTMARK_SERVER_TOKEN='PLACEHOLDER' -a reload-api
# Venture deploys on Vercel (the per-venture release pipeline target):
flyctl secrets set VENTURE_DEPLOY_PROVIDER='vercel' \
  VERCEL_TOKEN='PLACEHOLDER' VERCEL_TEAM_ID='PLACEHOLDER' VERCEL_PROJECT_ID='PLACEHOLDER' -a reload-api
# Connect-Claude one-click OAuth (until set, the flow stays coming_soon):
flyctl secrets set CLAUDE_OAUTH_CLIENT_ID='PLACEHOLDER' CLAUDE_OAUTH_CLIENT_SECRET='PLACEHOLDER' -a reload-api

flyctl secrets list -a reload-api   # confirm names + digests (never values)
```

> The capability-token signing secret, the Postmark server token, and every connect-once provider
> credential seal into the **#192 vault** through the in-app one-time connect flow — there is no
> `flyctl secrets set` for them, and the agent never sees the value.

---

## Step 2 — prepare the managed profile (substitute your id)

```bash
cd platform/deploy
# Substitute EVERY OWNER_WORKSPACE_ID with your real id (keep the quotes in table headers).
sed "s/OWNER_WORKSPACE_ID/<your-real-workspace-id>/g" \
  managed.owner-activation.example.toml > managed.toml
# Sanity: the global table must be empty (tenant isolation depends on it) and your id must appear.
grep -nE '^\[settings\]' managed.toml          # the [settings] header with nothing under it
grep -c '<your-real-workspace-id>' managed.toml # > 0
```

If you are doing **phased** activation (recommended), delete the Phase 2 and Phase 3 tables from
`managed.toml` for the first deploy, then add them back in later deploys. The phases are clearly fenced
with `# PHASE n` banners in the file.

---

## Step 3 — install the profile + deploy

The loader reads the managed layer from `RELOAD_MANAGED_CONFIG` (or `/etc/reload/managed.toml` by default).
Place `managed.toml` at that path on the running app — via your image build (a `COPY` into
`/etc/reload/managed.toml`) or a mounted Fly volume — then deploy:

```bash
cd platform
flyctl deploy --remote-only --config fly.toml -a reload-api
```

Deploys normally go through CI (#273); the manual command above is the operator fallback documented in
`platform/docs/runbooks/fly-deploy.md`. The managed layer is the **lock** — once present it cannot be
widened by env/user/repo layers.

> **Env-marker alternative.** The owner-workspace-first subset can also be turned on without a managed file
> using the env markers the loader already understands — e.g.
> `flyctl secrets set RELOAD_MARKETING_OWNER_WORKSPACE_ID='<id>' RELOAD_VENTURE_ENABLED='true' RELOAD_EMAIL_LIVE_SEND_ENABLED='true' RELOAD_EMAIL_OWNER_WORKSPACE_ID='<id>' RELOAD_CAPABILITY_TOKENS_LIVE_MINT='true' ... -a reload-api`.
> The managed profile is preferred because it activates **everything** in one reviewed, revert-by-one-file
> artifact; the env markers cover only the features that expose a `*_OWNER_WORKSPACE_ID` / `*_ENABLED` var.

---

## Step 4 — phased bring-up + how to verify each surface

Activate in order. After each phase, log in **as the owner workspace** and confirm the surfaces appear, and
log in as (or query) **a second test workspace** and confirm nothing changed for it.

### Phase 1 — coordination + UI + observability-read
- **Marketing fleet (#123):** the 8 department agents are seeded; @mention a lead and confirm the task
  carries real workspace context (not placeholders).
- **Agent Registry/Garden (#282/#284):** the agent catalog + per-workspace enable/disable surface renders.
- **Observability loops (#105/#112/#117/#148):** the reliability surface + status page render; SLO/watchdog
  evaluate; the flywheel files a deduped issue (needs `GITHUB_TOKEN`).
- **Verify / gate-pricing / voice (#106/#119/#114):** verifier gates run and escalate on failure; tickets
  ingest and land **open** (no auto-draft).
- **Verify isolation:** a second workspace shows none of these (board unchanged).

### Phase 2 — growth read/proactive + venture pipeline
- **Venture loop / factory (#96/#187):** the fundability gate + opportunity pipeline appear.
- **Analytics/SEO read (#270/#294):** tiles populate once you set a real provider + measurement id (until
  then they honestly read `dryrun`).
- **Support desk / monetization (#190/#188):** KB + SLA render; plan drafts are free — **activation queues
  as a #13 MONEY decision**.

### Phase 3 — real-action connectors (last, one at a time)
- **Billing (#98):** checkout opens for the owner workspace (Stripe keys set).
- **Email live send (#268):** compose a real send → it pauses in the queue as `email.live_send`; approve it
  → confirm Postmark delivered (check `Authentication-Results`).
- **Hosted publish / social / ads / venture deploy:** each proposes a real action and **stops at #13**
  (`hosted publish`, `social.publish_post`, `provisioning.customer_spend`, prod promote). Approve one and
  confirm the external receipt (a reachable URL / a real permalink / the deploy version advanced).
- **Verify isolation again** for a second workspace after each connector.

---

## Step 5 — the #13 invariant (what stays gated, by design)

The profile pins these OFF/safe and the unit test asserts it. **Do not flip them** to chase "more
autonomy" — they are the line between "real actions are possible" and "real actions happen without you."

| Switch | Value | Effect |
| --- | --- | --- |
| `selfHealing.autoRemediate` | `false` | breaches escalate, never self-act |
| `selfHealing.allowRollback` / `allowScale` | `false` | destructive ops stay #13-gated |
| `selfHealing.preCommitRollback` / `preCommitScale` | `false` | no pre-committed bypass |
| `selfHealing.requireApprovalForDestructive` | `true` | explicit gate |
| `supportDesk.autoSend` | `false` | every support reply is a #13 human gate |
| `voice.autoTriageDraft` | `false` | tickets land open, no proactive draft |
| `verification.autoSendReversible` | `false` | a verified deliverable still waits for a human |
| `verification.requireProductionGrounding` | `true` | the real-world tier is required |
| `acquisition.autoSend` | `false` | real channel sends never bypass the human |
| `ventureDeploys.preCommitProdPromote` | `false` | the customer-facing cutover stays #13-gated |
| `ventureDeploys.requireApprovalForProdPromote` | `true` | explicit gate |
| skillopt (no auto-adopt knob) | — | only STAGES #13 proposals, never self-edits |

`reach` (#280) is the one loop whose outbound email auto-sends **within per-channel daily caps** (its
design); LinkedIn is queue-only and paid prospect-data credits are #13 money-gated. Keep its caps
conservative and set a paid data `source` only when you intend to spend.

---

## Step 6 — honest `coming_soon` / dry-run list

Some surfaces turn **on** but stay an honest `coming_soon`/dry-run until a live provider **client** is wired
(the flag alone wires nothing live). Expect these to render but not act for real yet:

| Feature | Flag is on, but… | Live when |
| --- | --- | --- |
| **Capability tokens (#336)** | the verify provider is dry-run → tokens read back `unverified`; a `write` token still needs a prior #13 approval | a live verify provider client is wired |
| **Connect-once OAuth (#258)** | every customer connector renders the `coming_soon` stub; the per-connect #13 always applies | a per-department live OAuth client is wired |
| **Connect-Claude (#262)** | one-click connect stays `coming_soon` | `CLAUDE_OAUTH_*` client is configured |
| **Social posting (#269)** | the aggregator bridge posts nothing real (dry-run) | an aggregator is connected via #258 |
| **Outreach sender (#225)** | `sendProvider = "dryrun"` → recorded-only, no egress | you set a real sender + connect it |
| **SEO / Analytics read (#294/#270)** | `provider = "dryrun"` reports nothing | you set a real provider + key/measurement id |
| **Slack digest (#170)** | no digest delivered | `SLACK_BOT_TOKEN` + signing secret set |
| **Reliability email paging (#148)** | status page + incidents work; email pages don't | an SMTP URL var is set |

---

## Step 7 — revert (full rollback to today's behavior)

Activation is reversible by removing the one file (or the one marker) and redeploying:

```bash
# If you installed the managed file:
rm /etc/reload/managed.toml        # (or remove it from the image / volume)
# If you used the env-marker alternative, unset them:
flyctl secrets unset RELOAD_MARKETING_OWNER_WORKSPACE_ID RELOAD_VENTURE_ENABLED \
  RELOAD_EMAIL_LIVE_SEND_ENABLED RELOAD_CAPABILITY_TOKENS_LIVE_MINT -a reload-api
# Then redeploy:
cd platform && flyctl deploy --remote-only --config fly.toml -a reload-api
```

After revert, `loadConfig(<owner id>)` resolves back to `CONFIG_DEFAULTS` — identical to every other tenant.
Leaving the live-provider secrets set is harmless: with the flags gone, no feature reads them.

---

## Premortem (#200) notes

- **Tenant blast radius:** activation is per-tenant by construction (the `[workspace.<id>]` table) and
  proven by the isolation test. The global `[settings]` table is empty.
- **Irreversible actions (#200 §4):** none are pre-committed; each stays a #13 always-gate. The only
  pre-committed action anywhere in the profile is `ventureDeploys.autoRollbackOnSmokeFail` — a *safety*
  action (roll a broken venture image back), never a forward irreversible one.
- **Injection defense (#200 §6):** activation comes only from this trusted managed file + deployment
  secrets. No agent output, ticket body, or external content can flip a flag or widen scope; those are
  quarantined DATA on the read path. A green dogfood is a signal, not authorization.
- **Money (#200 §2):** every money action routes through the existing #13 money gate with the exact amount;
  ad spend additionally has a HARD `perActionCapCents` ceiling. This profile moves no money on its own.
