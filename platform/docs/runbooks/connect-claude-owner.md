# Runbook: Connect Claude for the owner workspace (#365)

**The one action that unlocks real agent runs is connecting the owner workspace's Claude token.** The fleet
is subscription-token-only, per tenant (`fly.toml`, ADR-0068/#246): with no `ANTHROPIC_API_KEY` fallback, an
unconnected workspace gets a friendly "reconnect your Claude" reply and produces nothing. This runbook is the
exact, ordered owner steps. It is **operational** — no code change, no secret is committed, and nothing here
is enabled by merging the #365 PR.

> Reversible at every step: disconnect in Settings, or unset the env markers below.

---

## Step 1 (required) — Connect via the manual paste path

This path is **always available** and needs no flags. It is the robust front door.

1. In the owner workspace, open **Settings → Connect Claude → "Connect Claude (advanced — paste a setup
   token)"**.
2. On a trusted machine, run `claude setup-token` and copy the resulting `sk-ant-oat-…` token.
3. Paste it into the field and **Connect**. The token is sealed (AES-256-GCM when
   `AGENT_CREDENTIALS_ENC_KEY` is set) into the per-tenant `workspace_agent_credentials` vault and is never
   shown again.
4. The first-run empty-state and the connection-health chip (Step 3) both route here, so an unconnected
   owner lands on this exact panel.

**Verify:** `GET /me/claude/health` returns `{ "health": { "state": "connected", "reason": null } }`, and an
owner @mention spawns a real `claude-code` session on `ANTHROPIC_MODEL=claude-opus-4-8` (passes the #246
launch preflight) instead of posting the connect prompt. **This is the acceptance for #365.**

> Security: never paste a token into a channel, a log, an issue, or a PR. It belongs only in this field.

---

## Step 2 (optional) — Feature the #262 one-click "Connect Claude" for the owner workspace

The one-click managed flow (ADR-0262) is built but **honestly `coming_soon` until a live Anthropic OAuth
client is registered**. We never fake a connection — so this is an owner step, not something the PR can do.

1. Register an Anthropic OAuth app and set its env (these are **secrets** — `fly secrets set`, never `[env]`
   in `fly.toml`, never committed):
   ```
   fly secrets set -a reload-api \
     CLAUDE_OAUTH_CLIENT_ID=<client id> \
     CLAUDE_OAUTH_AUTHORIZE_URL=<authorize endpoint> \
     CLAUDE_OAUTH_TOKEN_URL=<token endpoint> \
     CLAUDE_OAUTH_REDIRECT_URI=https://api.ipop.ai/me/claude/connect/callback
   ```
2. Enable the flow for the owner workspace only (owner-first; default-OFF):
   ```
   RELOAD_CONNECT_CLAUDE_ENABLED = "true"
   RELOAD_CONNECT_CLAUDE_OWNER_WORKSPACE_ID = "<OWNER_WORKSPACE_ID>"
   ```
   (or the equivalent `[workspace."<OWNER_WORKSPACE_ID>".connectClaude]` block in the managed layer.)

**Behavior:** with the env flags but **no** live `CLAUDE_OAUTH_*`, the panel still shows an honest
*coming-soon* note and the paste path (Step 1) — `POST /me/claude/connect/start` returns `501`. Once the live
client is set, the offer becomes `available`, the one-click button works, and its callback seals the token
into the same #68 vault. **Until then, use Step 1.**

---

## Step 3 (optional) — Show the connection-health chip in the console

A default-OFF, owner-first header chip surfaces *connected / not connected / token expired* at a glance and,
when the fleet can't run, IS the button to Connect Claude. It is a web build-time flag (Vercel env):

```
VITE_RELOAD_CONNECT_HEALTH_UI = "true"
VITE_RELOAD_CONNECT_HEALTH_OWNER_WORKSPACE_ID = "<OWNER_WORKSPACE_ID>"
```

Fail-closed: with the flag off (prod default) or no owner id named, the chip renders for nobody and the
console is byte-for-byte unchanged. The `/me/claude/health` read is harmless for any workspace; this flag
only governs the chip.

---

## What stays honest (not faked here)

- **One-click live connect** is `coming_soon` until the owner wires `CLAUDE_OAUTH_*` (Step 2).
- **`expired` health from an upstream-revoked-but-still-decryptable token** flips only after a real owner
  @mention observes the failure (the auth gate records it). We make **no** live token-validation call — the
  #365 boundary forbids handling the token, and #200 §3 forbids faking validity.

## Revert

- Disconnect: Settings → Connect Claude → **Disconnect** (clears the vault row).
- Unset the markers: remove `RELOAD_CONNECT_CLAUDE_*` / `VITE_RELOAD_CONNECT_HEALTH_*` and redeploy. The
  manual paste path (Step 1) always remains.
