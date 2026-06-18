# eve-bid pilot (#339)

A parallel pilot of the **@bid** department agent on [Vercel's eve framework](https://github.com/vercel/eve)
(`eve@0.11.5`). This is a **spike** to evaluate standardizing the fleet on eve. It changes **nothing**
in production and is **not** wired into the running app.

## Isolation guarantees

- **Not in the pnpm workspace.** `pnpm-workspace.yaml` globs `apps/*` and `packages/*`; `pilots/*` is
  excluded, so `pnpm -r build` / `pnpm -r typecheck` never touch this directory.
- **Eslint-ignored** (see `platform/eslint.config.js` → `pilots/**`).
- **No live provider connection.** The spend tool is a dry stub; no ad account, no money, no deploy.
- The behavior-parity guarantee is enforced by a unit test in the server suite:
  `apps/server/test/unit/eve-bid-pilot-parity.test.ts`.

## What maps to what

| ipop bespoke scaffold | eve equivalent | file here |
| --- | --- | --- |
| `blueprint.ts` `dept("ads", …)` system prompt (`prompt()`) | always-on charter | `agent/instructions.md` |
| `model: null` → managed `claude-opus-4-8` | AI Gateway model id | `agent/agent.ts` |
| `agents/skills/bid/knowledge.md` | on-demand skill (Agent Skills standard) | `agent/skills/knowledge.md` |
| `agents/skills/bid/runbook.md` | on-demand skill | `agent/skills/runbook.md` |
| `DRAFT_TOOLS` allowlist (built-ins) | eve default harness (`read_file`, `bash`, web) | (framework-provided) |
| the *draft* the agent produces | typed tool def | `agent/tools/propose_ads_plan.ts` |
| #13 approval gate for the `ads` external-send dept | `needsApproval: always()` (native HITL) | `agent/tools/record_ad_spend.ts` |
| `subagents/scope.ts` env wiring + #68 runtime + seeder | eve session runtime + HTTP channel | (framework-provided) |

The key finding: ipop's skills already follow the Agent Skills standard, which eve adopts verbatim
("a skill authored against that standard ports over as-is"), and ipop's #13 draft-then-gate invariant
maps onto eve's native, durable `needsApproval` primitive — a *pre-execution* human gate (honors
#200 §4: irreversible/money actions are gated before they run, never reviewed after).

## Measured receipts

All numbers are real (external receipts, not estimates) — see `docs/adrs/0339-eve-framework-pilot.md`
for the full table and methodology.

- `npx eve@latest init` (scaffold + dependency install): **184.72s real** (`/usr/bin/time -p`, exit 0).
- Authored LOC, per-agent: bespoke @bid ≈ 110 (2 skills + blueprint entry + manifest entry);
  eve @bid = 204 (`agent/` surface, incl. two typed tool defs + the native approval gate).

## Run it (manual, optional — needs Node 24 + network)

```bash
cd platform/pilots/eve-bid
npm install
npm exec -- eve dev        # interactive TUI on localhost
```

## Candidate #200 §3 verification artifact (the preview-URL flow)

`eve dev` and a Vercel deploy expose stable HTTP routes, so a real turn is externally verifiable —
the candidate production-grounded check #200 §3 asks for. **Not run here** (no deploy / no live
provider, per the #339 scope); documented so a follow-up can capture the receipt:

```bash
vercel deploy                                            # → public preview URL
curl https://<url>/eve/v1/health
curl -X POST https://<url>/eve/v1/session \
  -H 'content-type: application/json' \
  -d '{"message":"Draft a $3000/mo Google + Meta plan, then try to spend $500."}'
# → the draft returns; the spend pauses at session.waiting for human approval (observable in the
#   stream response and the Vercel Agent Runs dashboard) — a real receipt that the gate fired.
```
