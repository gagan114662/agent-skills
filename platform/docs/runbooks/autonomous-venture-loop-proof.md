# Autonomous venture-loop proof runbook

Use this to prove #403: ipop autonomously started a company, earned real money, learned from revenue, killed or scaled portfolio entries, repeated without human intervention, and stayed inside hard safety rails.

## Validate proof JSON

```sh
pnpm -C platform --filter @reload/server autonomous-venture-loop:proof -- --file /path/to/autonomous-venture-loop-proof.json
```

or:

```sh
cat /path/to/autonomous-venture-loop-proof.json | pnpm -C platform --filter @reload/server autonomous-venture-loop:proof
```

## Required evidence

- `start`: venture id, factory run id, live deploy receipt, and positive enabled background tick interval.
- `earn`: real provider payment event with positive amount and production readback receipt.
- `learn`: SkillOpt run that applied revenue reward and promoted earners while demoting non-earners.
- `portfolio`: lifecycle run that used verified revenue receipts only and made at least one kill and one scale decision.
- `loop`: at least two autonomous ticks, zero human interventions, and production readback receipt for the latest tick.
- `safety`: armed kill switch, positive hard spend cap, spend within cap, human approval required for cap raises, and production audit receipt.

## Closure boundary

Do not close #403 from a single launch, demo revenue, manual claims, vanity metrics, or code-only proof. The proof must pass the CLI against real production/provider readbacks from a repeated autonomous loop.
