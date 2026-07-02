# Agentic MapReduce Security Swarm

Date: 2026-07-02
Tracked issue: #1553
Reference pattern: https://devin.ai/blog/agentic-map-reduce

## Count Summary

| Metric | Count |
| --- | ---: |
| Repo files after generated/dependency excludes | 3,560 |
| Text candidate files | 3,471 |
| Files scanned | 3,454 |
| Large/binary files skipped | 17 |
| Matched files admitted to Map | 2,218 |
| Selector signals emitted | 22,422 |
| Bounded Map batches | 620 |

Batch distribution: `.github` 1, `agent-instructions` 2, `platform/apps/server` 523, `platform/apps/web` 38, `platform/cli` 1, `platform/other` 38, `platform/packages` 1, `platform/scripts` 11, `repo-docs-config` 4, `scripts` 1.

## Plan

The version-controlled threat model is in `docs/qa/security-threat-model.md`. It defines the assets, trust boundaries, false-positive gate, severity rules, and deterministic selectors for this repo.

Selectors used by `scripts/security-swarm.mjs`:

| Selector | Signals | Files |
| --- | ---: | ---: |
| `route-declaration` | 654 | 140 |
| `auth-boundary` | 15,573 | 1,505 |
| `outbound-fetch` | 347 | 150 |
| `ssrf-url-parse` | 464 | 197 |
| `deserialization` | 153 | 118 |
| `dangerous-api` | 130 | 80 |
| `secret-env` | 951 | 283 |
| `approval-gate` | 3,429 | 956 |
| `cors-origin` | 395 | 114 |
| `console-log` | 326 | 83 |

## Shard

`node scripts/security-swarm.mjs` walked the full repository from the repo root, excluded generated/dependency folders, emitted one signal per selector/line match, dropped files with no selector signal from Map, and bucketed the remaining signals into batches capped at 40 signals. The JSON work queue for this run was written during execution to `/tmp/security-swarm-signals.json`.

## Map And Reduce Findings

| ID | Severity | Confidence | Status | Finding | Evidence |
| --- | --- | --- | --- | --- | --- |
| F-001 | P0 | High | Remediated, compiled-build verified | Public onboarding deliverable SSRF could be reached from unauthenticated URL input and redirect chains. | `platform/apps/server/src/routes/onboarding.ts:59`, `platform/apps/server/src/onboarding/deliverable.ts:131`, `platform/apps/server/src/security/public-web-url.ts:150` |
| F-002 | P1 | High | Remediated, compiled-build verified | Live marketing site-reader accepted owner/workspace target URLs and followed redirects without DNS/private-IP checks. Default-off and owner-first reduced blast radius, but a compromised owner session or bad config could make the server fetch private services. | `platform/apps/server/src/routes/marketing-target.ts:87`, `platform/apps/server/src/marketing/site-reader/service.ts:27`, `platform/apps/server/src/marketing/site-reader/provider.ts:97` |
| F-003 | P2 | Medium | Inconclusive, not changed | Several internal deploy/readback probes still use stored/provider URLs with `redirect: "follow"` or direct URL fetch. Reducer did not confirm an untrusted write path in this run, but these should reuse the public-web guard if future producers accept customer URLs. | `platform/apps/server/src/verifiers/default.ts:41`, `platform/apps/server/src/self-healing/default.ts:82`, `platform/apps/server/src/delivery/default.ts:106` |
| F-004 | P2 | Low | False positive / documented local defaults | Secret and connection-string selector hits were docs, examples, tests, docker-compose, or local-dev fallbacks. Production env fail-fast is already covered by existing env tests. | `platform/apps/server/src/env.ts`, `platform/apps/server/test/unit/env-production-readiness.test.ts`, `platform/.env.example` |
| F-005 | P2 | Low | False positive | Public route files without `requireIdentity` were intentional read-only or signature/OAuth entry points: Google auth start/callback/status, opt-in public dogfood, sample console, health/status. Mutating workspace routes either use `requireIdentity` or `resolveIdentity` with workspace checks. | `platform/apps/server/src/routes/google-auth.ts`, `platform/apps/server/src/routes/public-dogfood.ts`, `platform/apps/server/src/routes/sample.ts`, `platform/apps/server/src/routes/agents.ts` |
| F-006 | P1 | High | Cleared | Send/spend approval-gate behavior remained unchanged. Approval-gate selectors were reviewed around executor registration and money/send actions; this PR touches no approval runtime or policy files. | `platform/apps/server/src/approvals/runtime.ts`, `platform/apps/server/src/approvals/policy.ts` |

## Attack Chains

- AC-001, P0 pre-remediation: unauthenticated `GET /onboarding/deliverable?url=...` plus attacker-controlled DNS or redirect target could make the server fetch private/reserved hosts such as `169.254.169.254`. This is now blocked by DNS resolution, private/reserved IP rejection, numeric-host rejection, port allow-listing, and manual redirect-hop validation.
- AC-002, P1 pre-remediation: authenticated owner sets or configures a marketing target URL, `marketing.readSiteContent` is enabled for the owner workspace, then a launch enriches a task by crawling that target. A private seed or redirect could reach internal services. This is now blocked by the same shared guard before the seed fetch and at every redirect hop.
- No confirmed auth-bypass plus ID-gated action chain was found. Workspace-mutating route hits either use `requireIdentity` or `resolveIdentity` and compare the route workspace id to the caller workspace.
- No send/spend approval bypass chain was found. This branch intentionally does not modify approval behavior.

## Remediation

Implemented in this branch:

- Added `platform/apps/server/src/security/public-web-url.ts` with DNS resolution, private/reserved IPv4 and IPv6 blocking, numeric host literal rejection, and `http`/`https` port restrictions limited to 80/443.
- Refactored `platform/apps/server/src/onboarding/deliverable.ts` to use the shared guard before the first fetch and on every redirect hop.
- Refactored `platform/apps/server/src/marketing/site-reader/provider.ts` to reject private seeds before fetch and to use manual redirect handling with validation on each hop.
- Expanded SSRF tests in `platform/apps/server/test/unit/onboarding-deliverable.test.ts` and `platform/apps/server/test/unit/site-reader-service.test.ts`.

Blocked ranges covered in tests: `0/8`, `10/8`, `127/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`, `fc00::/7`, and IPv4-mapped metadata addresses. Numeric host tests cover decimal, hex, abbreviated dotted forms, and non-standard ports.

## Verify

| Check | Result |
| --- | --- |
| Selector rerun: `node scripts/security-swarm.mjs >/tmp/security-swarm-signals-final.json` | Pass |
| Lint: `pnpm -C platform lint` | Pass |
| Focused unit tests: `pnpm -C platform --filter @reload/server exec vitest run --config vitest.config.ts test/unit/onboarding-deliverable.test.ts test/unit/site-reader-service.test.ts` | Pass: 39 tests |
| Server unit suite: `pnpm -C platform --filter @reload/server exec vitest run --config vitest.config.ts test/unit --reporter=dot` | Pass |
| Server slow suite: `pnpm -C platform --filter @reload/server test:slow` | Pass: 27 tests |
| Server typecheck: `pnpm -C platform --filter @reload/server typecheck` | Pass |
| Platform typecheck: `pnpm -C platform typecheck` | Pass |
| Server build: `pnpm -C platform --filter @reload/server build` | Pass |
| Whitespace: `git diff --check` | Pass |
| Compiled-output repro | Pass: onboarding private DNS blocked before fetch; marketing private redirect blocked after first public hop |

Compiled-output repro command:

```sh
node --input-type=module <<'NODE'
import { readSiteSnapshot } from './platform/apps/server/dist/onboarding/deliverable.js';
import { LiveSiteReaderProvider } from './platform/apps/server/dist/marketing/site-reader/provider.js';

const blockedResolver = async () => [{ address: '169.254.169.254', family: 4 }];
let fetchCalls = 0;
const blocked = await readSiteSnapshot(
  { url: 'https://metadata.example', host: 'metadata.example', name: 'Metadata' },
  async () => { fetchCalls += 1; return new Response('<title>bad</title>', { status: 200, headers: { 'content-type': 'text/html' } }); },
  blockedResolver,
);
if (blocked !== null || fetchCalls !== 0) throw new Error('private DNS answer was fetched');

const resolver = async (hostname) => hostname === 'private.example'
  ? [{ address: '10.0.0.7', family: 4 }]
  : [{ address: '93.184.216.34', family: 4 }];
let redirectFetchCalls = 0;
globalThis.fetch = async () => {
  redirectFetchCalls += 1;
  return new Response(null, { status: 302, headers: { location: 'http://private.example/admin' } });
};
const pages = await new LiveSiteReaderProvider(undefined, undefined, resolver).fetchPages('https://public.example/');
if (pages.length !== 0 || redirectFetchCalls !== 1) throw new Error('private redirect hop was not blocked');
NODE
```

## Notes For The Next Run

- Persisting the full signal JSON is intentionally skipped because it is large and reproducible from `scripts/security-swarm.mjs`.
- If claim producers are added for verifiers or self-healing accepts customer-written URLs, promote F-003 from P2/inconclusive and wire those probes through `validatePublicWebUrl`.
- Re-run the swarm after major route additions or provider integrations; selectors are versioned and can be diff-scanned.
