# platform/ hardcoded and production-readiness audit

Date: 2026-07-01  
Scope: platform/apps/server, platform/apps/web, platform/packages/*, platform/cli, platform scripts/config used by those workspaces.  
Mode: audit only; no fixes applied.

## Count summary

| Severity | Count | Notes |
| --- | ---: | --- |
| P0 | 0 | No confirmed committed live secret/token found in platform/. The Telegram BotFather token from chat was not found in the tree. |
| P1 | 40 | Runtime or user-visible paths that can affect production behavior, messaging-channel UX, billing/auth, or live proof. |
| P2 | 47 | Dev/script/docs/test or intentional scaffold patterns that still need cleanup, config centralization, or owner acknowledgement. |

## 1. Hardcoded URLs, hosts, and ports

### P1
- platform/apps/server/src/env.ts:477 - runtime DATABASE_URL falls back to postgres://reload:reload@localhost:5433/reload.
- platform/apps/server/src/env.ts:480 - runtime REDIS_URL falls back to redis://localhost:6379.
- platform/apps/web/src/api/config.ts:17 - hardcoded production API base https://api.ipop.ai instead of env-only config.
- platform/apps/web/src/api/config.ts:67 - WebSocket fallback emits ws://localhost/ws when no current host is present.
- platform/apps/server/src/routes/a2a.ts:58 - A2A AgentCard base URL can fall back to localhost:3000.
- platform/apps/server/src/routes/inbound-leads.ts:101 - public lead confirmation URL falls back to host localhost.
- platform/apps/server/src/messaging/inbound-team-launch.ts:82 - messaging launch help falls back to https://ipop.ai/everyday.
- platform/apps/server/src/routes/telegram.ts:48 - Telegram expired-link copy hardcodes https://ipop.ai/everyday.
- platform/apps/server/src/telegram/service.ts:130 - Telegram clipped updates hardcode https://ipop.ai/everyday.
- platform/apps/server/src/whatsapp/service.ts:144 - WhatsApp clipped updates hardcode https://ipop.ai/everyday.
- platform/apps/server/src/imessage/relay-worker-cli.ts:143 - iMessage relay worker falls back to https://api.ipop.ai.
- platform/apps/web/src/components/console/InboundLeadsPanel.tsx:37 - booking proof URL uses https://ipop.ai as base.
- platform/cli/reload.mjs:83 - CLI API base defaults to http://localhost:3000.
- platform/apps/server/src/outreach/default.ts:16 - outreach trial URL falls back to https://ipop.ai/start.

### P2
- platform/apps/server/drizzle.config.ts:8 - migration tooling defaults to local Postgres URL with dev credentials.
- platform/docker-compose.yml:58 - full-stack compose binds PORT=3000.
- platform/docker-compose.yml:62 - compose publishes 3000:3000.
- platform/docker-compose.yml:81 - compose healthcheck probes http://localhost:3000/readyz.
- platform/apps/server/src/runtime/verify-release-cli.ts:83 - release verifier defaults to legacy https://reload-api.fly.dev.
- platform/apps/server/src/messaging/external-room-doctor-cli.ts:17 - doctor CLI hardcodes https://api.ipop.ai.
- platform/apps/server/src/uptime/check.ts:151 - uptime defaults hardcode api.ipop.ai and ipop.ai.
- platform/apps/server/src/attribution/badge.ts:36 - attribution badge base defaults to https://ipop.ai.

## 2. Secrets, keys, passwords, and default fallback secrets

### P1
- platform/apps/server/src/env.ts:477 - runtime database fallback includes username/password reload:reload.
- platform/apps/server/src/env.ts:480 - runtime Redis fallback allows unauthenticated local Redis when REDIS_URL is missing.

### P2
- platform/apps/server/drizzle.config.ts:8 - migration config repeats reload:reload local DB credentials.
- platform/docker-compose.yml:5 - committed dev POSTGRES_USER=reload.
- platform/docker-compose.yml:6 - committed dev POSTGRES_PASSWORD=reload.
- platform/docker-compose.yml:42 - compose migrate DATABASE_URL includes reload:reload.
- platform/docker-compose.yml:59 - compose server DATABASE_URL includes reload:reload.
- platform/apps/server/src/routes/inbound-leads.ts:74 - non-production fallback secret dev-inbound-lead-confirmation is baked in.
- platform/apps/server/src/auth/oauth-state.ts:42 - dev OAuth state secret is generated in process; safe-ish, but still a fallback secret path.
- platform/apps/server/src/connections/token-default.ts:42 - dev capability-token secret is generated in process; production throws if unset, but the fallback exists.
- platform/apps/server/scripts/perf.ts:81 - perf script injects STRIPE_WEBHOOK_SECRET=whsec_perf_nonsecret.
- platform/apps/server/scripts/perf.ts:95 - perf script uses password perf-pass.

## 3. Magic identifiers, model names, emails, phones, tenant/channel/user IDs

### P1
- platform/apps/server/src/runtime/models.ts:19 - DEFAULT_AGENT_MODEL is hardcoded to claude-opus-4-8.
- platform/apps/server/src/runtime/models.ts:29 - KNOWN_AGENT_MODELS is a baked allowlist of Claude model IDs.
- platform/apps/server/src/observability/cost/pricing.ts:48 - token pricing table hardcodes model IDs and rates.
- platform/apps/server/src/observability/cost/service.ts:83 - cost fallback model hardcodes claude-opus-4-8.
- platform/apps/server/src/messaging/inbound-team-launch.ts:72 - messaging-first launch hardcodes room channel general.
- platform/apps/server/src/messaging/inbound-team-launch.ts:73 - launch team is hardcoded to scout/quill/echo/bid.

### P2
- platform/.env.example:33 - sample/default ANTHROPIC_MODEL is claude-opus-4-8.
- platform/apps/server/src/db/seed.ts:9 - seed script hardcodes workspace slug demo.
- platform/apps/server/src/db/seed.ts:18 - seed script hardcodes gagan@getfoolish.com.
- platform/apps/server/scripts/realworld-canary.ts:61 - canary hardcodes workspaceId canary-workspace.
- platform/apps/server/scripts/cloud-e2e-soak.ts:62 - soak script hardcodes workspaceId soak.
- platform/apps/server/scripts/vercel-sandbox-smoke.ts:48 - sandbox smoke hardcodes workspaceId smoke.
- platform/apps/server/src/selfqa/driver.ts:251 - browser QA uses workspaceId selfqa-synthetic.
- platform/apps/server/src/selfqa/caps.ts:22 - self-QA default workspace slug is selfqa-system.

## 4. Stub, mock, fake, canned, and sample data on non-test paths

### P1
- platform/apps/server/src/env.ts:491 - AGENT_HARNESS defaults through the dev profile to demo unless production config overrides it.
- platform/apps/server/src/env.ts:682 - DEPLOY_PROVIDER defaults to dryrun.
- platform/apps/server/src/env.ts:693 - BILLING_PROVIDER defaults to none and BILLING_MODE to test.
- platform/apps/server/src/routes/sample.ts:38 - public /sample/console route serves static sample content when enabled.
- platform/apps/server/src/onboarding/signup-entry.ts:98 - sample SEO deliverable is static canned content with example.com and +18% clicks.
- platform/apps/web/src/components/everyday/everyday-data.ts:347 - seedEveryday exports hardcoded fake live-looking workspace/customer data.
- platform/apps/web/src/components/everyday/everyday-data.ts:580 - ipopDogfoodEveryday exports static dogfood/dashboard narrative instead of live tenant metrics.

### P2
- platform/apps/server/src/db/seed.ts:1 - demo seed creates Demo Workspace, Scout, general, and a canned welcome message.
- platform/apps/web/src/components/demo/DemoSandbox.tsx:47 - public demo has a hardcoded example URL acme.com.

## 5. Not-implemented paths, TODO/FIXME/HACK, type suppressions, as any, swallowed errors

### P1
- platform/apps/server/src/oz-loops/spec.ts:38 - generated specs include _TODO: fill in._ sections on a real source path.

### P2
- platform/apps/server/src/team/sso.ts:2 - SSO seam is explicitly interface-only / not implemented.
- platform/apps/server/src/gate-pricing/invariants.ts:64 - @ts-expect-error in source code as a type proof.
- platform/apps/server/src/demand/provenance.ts:122 - @ts-expect-error in source code as a type proof.
- platform/apps/server/test/unit/social-publishing-service.test.ts:113 - @ts-expect-error in test.
- platform/apps/server/test/unit/realworld-site-pr.test.ts:183 - @ts-expect-error in test.
- platform/apps/server/test/unit/action-gate-classify.test.ts:85 - @ts-expect-error in test.
- platform/apps/server/test/unit/agent-sessions-routes.test.ts:70 - sessionManager as any hides route contract shape.
- platform/apps/server/test/unit/git-review-routes.test.ts:90 - sessionManager as any hides route contract shape.
- platform/apps/server/test/unit/git-review-routes.test.ts:92 - gitWorkspace as any hides route contract shape.
- platform/apps/server/test/unit/git-review-routes.test.ts:94 - gitHubProvider as any hides route contract shape.
- platform/apps/server/src/realtime/bus.ts:64 - production Redis pub/sub failures log with console.warn instead of the app logger.
- platform/apps/server/src/realtime/bus.ts:67 - production Redis pub/sub failures log with console.warn instead of the app logger.
- Multiple unbound catch blocks were found across server/web runtime paths via catch { ... }; many are intentional best-effort fallbacks, but they are too broad to trust without a follow-up lint rule and focused review.

## 6. Disabled, skipped, focused, or known-failing tests

### P1
- platform/apps/web/src/components/PricingTable.visibility.test.ts:70 - known residual failure: reduced-motion pricing card assertion expects opacity: 1 and animation: none.
- platform/apps/web/src/components/Workspace.test.tsx:26 - known residual failure: first-run CTA should be discoverable by button role/name.

### P2
- No committed .skip, .only, xit, xdescribe, test.todo, describe.todo, or commented-out test declarations were found under platform/apps, platform/packages, or platform/cli in the tightened scan.

## 7. Production-readiness gaps

### P1
- platform/apps/server/src/env.ts:474 - loadEnv returns defaults directly; there is no single production env validation gate that rejects missing DATABASE_URL/REDIS_URL/RELOAD_WEB_ORIGIN/channel-provider config before boot.
- platform/apps/server/src/env.ts:491 - default posture is dev/demo unless RELOAD_PROFILE/AGENT_HARNESS is explicitly production-safe.
- platform/apps/server/src/env.ts:650 - Telegram config accepts missing TELEGRAM_BOT_TOKEN/TELEGRAM_WEBHOOK_SECRET as undefined instead of failing production boot.
- platform/apps/server/src/env.ts:657 - WhatsApp config accepts missing WHATSAPP_ACCESS_TOKEN/WHATSAPP_APP_SECRET as undefined instead of failing production boot.
- platform/apps/server/src/env.ts:640 - iMessage config accepts missing relay settings as disabled/undefined instead of declaring production readiness.
- platform/apps/server/src/env.ts:682 - deploy provider defaults to dryrun; real publish can silently remain simulated.
- platform/apps/server/src/env.ts:693 - billing provider defaults to none/test; checkout/revenue can silently remain simulated.
- platform/apps/server/src/routes/inbound-leads.ts:427 - public lead capture writes durable leads but returns 503 if confirmation secret is absent, leaving production dependent on an optional env instead of boot validation.

### P2
- platform/apps/server/src/http/cors.ts:33 - CORS is env-gated and exact-match, but no production assertion verifies RELOAD_WEB_ORIGIN is configured for split web/API deploys.
- platform/apps/server/src/routes/agent-interface.ts:42 - /openapi.json is public by design; keep it documented in the public-route allowlist.
- platform/apps/server/src/routes/sample.ts:38 - /sample/console is public by design; keep it documented in the public-route allowlist.
- platform/apps/server/src/routes/public-dogfood.ts:28 - /dogfood/:slug is public by design but controlled by enabled slugs; keep enabled slugs audited.
- platform/apps/server/src/routes/agents.ts:20 - this route uses resolveIdentity inline, not the standard requireIdentity helper; safe on inspection but harder for automated auth coverage.

## Immediate remediation order I would take after approval

1. Add production env validation that fails boot for missing DB/Redis, web origin, channel webhook secrets, and real provider/billing/deploy posture.
2. Remove runtime localhost/dev DB/Redis/API URL fallbacks from production code paths; keep local defaults only in explicit dev config.
3. Replace messaging-channel hardcoded ipop.ai links with a single configured public app origin.
4. Move model defaults/allowlists/pricing to versioned config or an operator-owned registry.
5. Quarantine demo/sample/dogfood payloads behind explicit routes and remove them from signed-in/live dashboard defaults.
6. Fix the two known residual tests, then add a lint/check for focused/skipped tests, source @ts-expect-error, and unreviewed catch blocks.
