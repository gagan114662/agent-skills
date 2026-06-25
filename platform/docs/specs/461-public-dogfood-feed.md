# Spec: Public Dogfood Feed (#461)

## Objective
Expose a public, shareable view where ipop markets ipop.ai with ipop, backed by real agent-run receipts rather than a synthetic homepage vignette.

A buyer should be able to open one URL and see recent redacted work from the owner workspace: agent runs, phases, artifacts, approval moments, and outcomes that prove the fleet is doing real SEO, content, social, analytics, and product-marketing work for ipop.ai itself.

This first slice is read-only. It projects existing trace/run data into a safe public feed and shows an honest empty state when no public receipts are available.

## Tech Stack
- Fastify routes in `platform/apps/server`
- Existing trace service and agent trace repositories
- Existing theater projection/redaction ideas from `apps/server/src/trace/theater.ts`
- React public route in `platform/apps/web`
- Vitest for pure projection and component tests

## Commands
- Server unit: `pnpm --filter @reload/server exec vitest run --config vitest.config.ts test/unit/public-dogfood.test.ts`
- Web unit: `pnpm --filter @reload/web exec vitest run src/components/dogfood/PublicDogfood.test.tsx`
- Typecheck: `pnpm --filter @reload/server typecheck && pnpm --filter @reload/web typecheck`

## Project Structure
- `apps/server/src/public-dogfood/project.ts` - pure projection/redaction from trace runs/events to public DTOs
- `apps/server/src/routes/public-dogfood.ts` - unauthenticated, opt-in public feed route
- `apps/server/test/unit/public-dogfood.test.ts` - projection and redaction tests
- `apps/web/src/components/dogfood/PublicDogfood.tsx` - public feed page
- `apps/web/src/components/dogfood/PublicDogfood.test.tsx` - rendering/empty-state tests
- `apps/web/src/App.tsx` - public `/dogfood` route before the authenticated app boundary

## Data Contract
The public route returns only a redacted projection:

- workspace display name or public slug
- feed title and last updated time
- receipt id that is not the raw trace id
- agent name
- channel or workstream label
- phase (`thinking`, `tool`, `artifact`, `approval`, `outcome`, `blocked`)
- one-line summary
- artifact label and public artifact URL when available
- approval status when the receipt represents a public approval moment
- source timestamp

The DTO must not include raw trace payloads, prompt text, tool inputs, secrets, customer identifiers, workspace ids, member ids, credential names, private URLs, or external account identifiers.

## Boundaries
- Always keep the feed default-off unless a workspace/feed is explicitly public-enabled.
- Always use existing trace redaction as an input, then apply a second public projection layer.
- Always produce an honest empty state: `No public dogfood receipts yet` is better than fake activity.
- Ask first before exposing raw logs, raw tool payloads, customer names, external account identifiers, or private artifact URLs.
- Never expose the authenticated trace endpoints anonymously.
- Never fabricate activity, metrics, agent names, or outcomes.
- Never treat homepage copy as proof; only run/trace/artifact receipts count.

## Success Criteria
- `/dogfood` renders without login.
- The page is sourced from a server public feed endpoint, not hard-coded demo rows.
- The server route returns 404 or an empty non-sensitive response when the public dogfood feed is disabled.
- When enabled and trace runs exist, the feed shows real redacted receipts from the owner ipop workspace.
- Tests prove raw trace payloads, workspace ids, private ids, and obvious secret-looking values are absent from the public DTO.
- Tests prove the web page renders both the honest empty state and a populated receipt feed.
- The implementation can later connect to #1196 so evaluator-discovered gaps can appear as dogfood receipts and issues.

## Non-goals
- No public SSE stream in the first slice.
- No new agent execution runtime.
- No live outbound sends, ad spend, or automatic publishing.
- No customer-data public feed.
- No replacement for the authenticated theater view.

## Why This Matters
The current live homepage claims real agents and a faithful console render, but a buyer cannot inspect real work. A public dogfood feed turns the marketing promise into proof: ipop is using ipop to build ipop, and the visible receipts become the acquisition loop.
