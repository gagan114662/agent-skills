# Spec: Launch-Day Coordination Playbook (#600)

## Objective
Give the owner a reusable launch-day playbook that turns a launch brief into a timed, assigned checklist and a runnable workflow. The workflow prepares assets, queues human-reviewed outbound drafts, starts live monitoring, and notifies the owner as launch commander.

## Tech Stack
- TypeScript server code in `platform/apps/server`
- Existing workflow engine (`src/workflows/*`) for task launch, draft-send approval, notifications, and run ledger
- Vitest for unit/integration coverage

## Commands
- Focused unit: `pnpm --filter @reload/server exec vitest run --config vitest.config.ts test/unit/launch-playbook.test.ts`
- Focused integration: `pnpm --filter @reload/server exec vitest run --config vitest.integration.config.ts test/integration/workflows.test.ts`
- Typecheck: `pnpm run typecheck`
- Lint: `pnpm run lint`

## Project Structure
- `apps/server/src/workflows/launch-playbook.ts` - pure playbook builder
- `apps/server/src/routes/workflows.ts` - workspace route to create/run the playbook workflow
- `apps/server/test/unit/launch-playbook.test.ts` - pure builder tests
- `apps/server/test/integration/workflows.test.ts` - route/run proof over real Postgres with fake launcher

## Code Style
Keep the playbook declarative and data-only.

## Testing Strategy
- Unit-test the pure builder for checklist timing, owners, approval-gated draft sends, and monitoring tasks.
- Integration-test the route with the existing workflow engine to prove running the playbook launches agent tasks, creates pending approvals, notifies the owner, and records a run.

## Boundaries
- Always: route external posts through `draft_send` / #13 approval, keep workspace isolation, use existing workflow engine.
- Ask first: adding new tables, adding dependencies, sending or publishing anything live.
- Never: introduce a direct outbound send path, real spend, or platform API posting from this playbook.

## Success Criteria
- A launch brief produces a checklist with due times, owners, phases, and channel targets.
- Creating/running the playbook creates a workflow and a run ledger entry.
- Running the playbook starts launch-prep/monitoring agent tasks and queues outbound drafts as pending approvals.
- Unit and integration tests cover the builder and route.
