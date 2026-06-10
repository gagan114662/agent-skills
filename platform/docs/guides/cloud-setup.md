# Guide: Enable Cloud + a Real Agent (zero → first cloud agent)

> Implements the guided-setup half of [#69](https://github.com/gagan114662/agent-skills/issues/69).
> See also: [spec](../specs/38-cloud-default-posture.md), [ADR-0038](../adrs/0038-cloud-default-posture.md).

By default the platform runs the **`dev`** posture: agents execute **locally** with the **`demo`** echo
harness. No cloud, no model spend, no binaries — this is what CI and a fresh clone use, and you don't
have to configure anything.

This guide turns on the **`prod`** posture: each session runs in a **Vercel Sandbox** microVM with the
real **Claude Code** agent. The whole flip is one switch (`RELOAD_PROFILE=prod`), and a **preflight**
check validates your environment *before any run* so you never start a half-broken session.

> **The golden rule:** run `pnpm -C platform --filter @reload/server preflight` (or `reload doctor`)
> until it's green **before** launching. Preflight makes **no cloud call** and prints only variable
> **names** + pass/warn/fail — never a secret value.

---

## 1. Pick the cloud posture

```bash
export RELOAD_PROFILE=prod      # = AGENT_RUNTIME=sandbox + AGENT_HARNESS=claude-code
```

`prod` sets the **defaults** for the runtime and harness. An explicit `AGENT_RUNTIME` / `AGENT_HARNESS`
still overrides the profile, so you can mix (e.g. `prod` but `AGENT_HARNESS=demo` to test the sandbox
without model spend).

## 2. Authenticate Vercel (the sandbox backend)

Pick **one** of:

- **OIDC (recommended on Vercel):**
  ```bash
  vercel link && vercel env pull      # writes VERCEL_OIDC_TOKEN into your local env
  ```
- **Access token (off-Vercel / external CI):** set **all three**
  ```bash
  export VERCEL_TOKEN=...  VERCEL_TEAM_ID=...  VERCEL_PROJECT_ID=...
  ```

Install the sandbox SDK (kept optional so it isn't forced into the lockfile):

```bash
pnpm --filter @reload/server add @vercel/sandbox
```

## 3. Authenticate the agent (Claude Code)

Pick **one** of:

- An interactive login on the host: `claude login`
- An API key: `export ANTHROPIC_API_KEY=...`
- A cloud provider credential chain: `export CLAUDE_CODE_USE_BEDROCK=1` (or `CLAUDE_CODE_USE_VERTEX=1`)
  — no API key needed; the provider's credential chain supplies auth.

Make sure the `claude` binary is on `PATH` (or set `CLAUDE_BIN=/abs/path/to/claude`).

## 4. Validate before any run

```bash
pnpm -C platform --filter @reload/server preflight
```

Example of a **misconfigured** prod posture caught before it can touch the cloud:

```
Preflight — profile "prod" (runtime=sandbox, harness=claude-code)

  ✗ vercel-auth    no Vercel auth — set VERCEL_OIDC_TOKEN, or the access-token trio
      ↳ Authenticate with VERCEL_OIDC_TOKEN (run `vercel link && vercel env pull`), or set
        all of VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID.
  ✓ vercel-sdk     @vercel/sandbox SDK is installed
  ✓ claude-binary  Claude Code binary found (claude)
  ⚠ claude-auth    no ANTHROPIC_API_KEY detected — Claude Code will use an existing interactive login if present

NOT READY — fix the ✗ checks above, then re-run preflight.
```

Fix the `✗` lines and re-run until you see **`OK — the "prod" posture is ready.`** (the command exits
non-zero while anything fails, so you can gate a deploy script on it). A `⚠` is informational — it does
not block: an interactive `claude login` is a valid auth path we can't confirm without spending.

## 5. Start the server and verify it

```bash
pnpm -C platform --filter @reload/server dev
reload doctor            # GET /preflight against the running server (needs RELOAD_TOKEN)
```

`reload doctor` runs the same checks against the live server and exits non-zero if it isn't ready.

## 6. Launch your first cloud agent

Launch a session as usual (REST `POST /channels/:cid/agent-sessions`, the `reload` CLI, the web client,
or an @mention). The server runs the same preflight at launch: if the posture is misconfigured the
launch is rejected with **`412 Precondition Failed`** and the actionable report — **before any cloud
call and without persisting a session row**. Once preflight is green, the agent runs in a Vercel
sandbox and streams its work back into the channel.

---

## The checks, in one place

| Check | When | Pass when |
|---|---|---|
| `vercel-auth` | runtime=sandbox | `VERCEL_OIDC_TOKEN`, **or** all of `VERCEL_TOKEN`+`VERCEL_TEAM_ID`+`VERCEL_PROJECT_ID` |
| `vercel-sdk` | runtime=sandbox | `@vercel/sandbox` is installed |
| `claude-binary` | harness=claude-code | `claude` (or `CLAUDE_BIN`) is on `PATH` |
| `claude-auth` | harness=claude-code | `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_USE_BEDROCK`/`_USE_VERTEX` (else a non-blocking `warn`) |
| `runtime` / `harness` | local / demo | always — the default posture needs no credentials |

## Security notes

- Preflight reads only the **presence** of credentials and reports variable **names** — it never logs
  or returns a secret value. Secrets stay on the `AGENT_SECRETS` / `SecretsResolver` path (#25).
- The default posture stays `dev` (local/demo). Whether to flip the **global default** to `prod` is a
  separate decision, gated on #37 (e2e proof at scale) — see [ADR-0038](../adrs/0038-cloud-default-posture.md).
