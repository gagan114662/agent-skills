# Goal Loop Proof

Use this gate when a feature claims the agent is no longer waiting on a human prompt between turns.

```bash
pnpm -C platform --filter @reload/server goal-loop:proof -- --file goal-loop-proof.json
```

The proof must show:

- a durable goal id and specific objective
- a scheduled or event-driven trigger, not manual prompting
- at least two automated turns
- an executable verifier command with a passing receipt
- state persisted outside the agent turn and surviving restart
- bounded turns/tokens plus a non-infinite retry policy
- root-cause/blocker logging and an escalation path
- an explicit next-move decision

This gate does not prove first-customer revenue, external paid work, or external room delivery by itself. It proves the closed-loop control plane those proof gates can run inside.
