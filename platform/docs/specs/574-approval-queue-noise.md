# Spec: Approval Queue Noise Filter (#574)

## Objective
Keep the user-facing approval queue focused on genuine ship decisions. Internal watchdog escalations and workspace-context-only deliverables must remain auditable in the database, but they should not appear in the review queue or pending badge that owners use to decide what ships.

## Tech Stack
- Fastify approval routes in `platform/apps/server/src/routes/approvals.ts`
- Drizzle-backed approval repository in `platform/apps/server/src/db/repositories/approvals.ts`
- Pure queue visibility classifier under `platform/apps/server/src/approvals/`
- Vitest unit coverage and the existing platform CI gates

## Commands
- Unit: `pnpm --filter @reload/server exec vitest run --config vitest.config.ts test/unit/approval-review-queue.test.ts`
- Typecheck: `pnpm -C platform run --if-present typecheck`
- Lint: `pnpm -C platform run --if-present lint`
- Diff check: `git diff --check`

## Project Structure
- `platform/apps/server/src/approvals/review-queue.ts` -> pure visibility decisions
- `platform/apps/server/src/routes/approvals.ts` -> applies visibility before returning queue items
- `platform/apps/server/test/unit/approval-review-queue.test.ts` -> regression coverage

## Code Style
```ts
export function isReviewQueueVisible(request: ReviewQueueApproval): boolean {
  if (request.actionType === "watchdog.escalate") return false;
  return true;
}
```

Keep the classifier pure and string/data based. Do not delete or mutate approval rows.

## Testing Strategy
Use unit tests for all visibility decisions: real outbound approvals stay visible; watchdog escalations are hidden; workspace-facts-only deliverables are hidden; real deliverables remain visible.

## Boundaries
- Always: preserve durable audit records and direct `/approvals/:rid` access for authorized users.
- Ask first: deleting historical approval rows or changing approval policy semantics.
- Never: hide money/spend approvals or external send approvals from the owner queue.

## Success Criteria
- Pending queue responses exclude `watchdog.escalate` records.
- Pending/executed queue responses exclude `agent.deliverable` cards whose summary/task is the workspace-facts preamble rather than a real task.
- Genuine ship decisions such as `external.send`, `billing.refund`, and real `agent.deliverable` cards remain visible.
- Unit/type/lint checks pass.
