# Agentic MapReduce Security Swarm

Date: 2026-07-02
Tracked issue: #1553
Reference pattern: https://devin.ai/blog/agentic-map-reduce

## Count Summary

| Metric                                         |  Count |
| ---------------------------------------------- | -----: |
| Repo files after generated/dependency excludes |  3,575 |
| Text candidate files                           |  3,485 |
| Files scanned                                  |  3,468 |
| Large/binary files skipped                     |     17 |
| Matched files admitted to Map                  |  2,231 |
| Selector signals emitted                       | 22,643 |
| Bounded Map batches                            |    627 |

Batch distribution: `.github` 1, `agent-instructions` 2, `platform/apps/server` 528, `platform/apps/web` 38, `platform/cli` 1, `platform/other` 40, `platform/packages` 1, `platform/scripts` 11, `repo-docs-config` 4, `scripts` 1.

## Plan

The version-controlled threat model is in `docs/qa/security-threat-model.md`. It defines the assets, trust boundaries, false-positive gate, severity rules, and deterministic selectors for this repo.

Selectors used by `scripts/security-swarm.mjs`:

| Selector              | Signals | Files |
| --------------------- | ------: | ----: |
| `route-declaration`   |     660 |   141 |
| `auth-boundary`       |  15,666 | 1,513 |
| `outbound-fetch`      |     349 |   151 |
| `ssrf-url-parse`      |     479 |   198 |
| `dns-rebinding-pin`   |      43 |    11 |
| `nat64-bypass`        |       8 |     2 |
| `unbounded-buffering` |      35 |    20 |
| `deserialization`     |     153 |   118 |
| `dangerous-api`       |     130 |    80 |
| `secret-env`          |     951 |   283 |
| `approval-gate`       |   3,448 |   961 |
| `cors-origin`         |     395 |   114 |
| `console-log`         |     326 |    83 |

## Shard

`node scripts/security-swarm.mjs` walked the full repository from the repo root, excluded generated/dependency folders, emitted one signal per selector/line match, dropped files with no selector signal from Map, and bucketed the remaining signals into batches capped at 40 signals. The JSON work queue for this rerun was written during execution to `/tmp/security-swarm-followup.json`.

## Map And Reduce Findings

| ID    | Severity | Confidence | Status                                     | Finding                                                                                                                                                                                                                                                                                              | Evidence                                                                                                                                                                                                                                                |
| ----- | -------- | ---------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-001 | P0       | High       | Remediated, compiled-build verified        | Public onboarding deliverable SSRF could be reached from unauthenticated URL input and redirect chains.                                                                                                                                                                                              | `platform/apps/server/src/routes/onboarding.ts:59`, `platform/apps/server/src/onboarding/deliverable.ts:131`, `platform/apps/server/src/security/public-web-url.ts:150`                                                                                 |
| F-002 | P1       | High       | Remediated, compiled-build verified        | Live marketing site-reader accepted owner/workspace target URLs and followed redirects without DNS/private-IP checks. Default-off and owner-first reduced blast radius, but a compromised owner session or bad config could make the server fetch private services.                                  | `platform/apps/server/src/routes/marketing-target.ts:87`, `platform/apps/server/src/marketing/site-reader/service.ts:27`, `platform/apps/server/src/marketing/site-reader/provider.ts:97`                                                               |
| F-003 | P2       | Medium     | Inconclusive, not changed                  | Several internal deploy/readback probes still use stored/provider URLs with `redirect: "follow"` or direct URL fetch. Reducer did not confirm an untrusted write path in this run, but these should reuse the public-web guard if future producers accept customer URLs.                             | `platform/apps/server/src/verifiers/default.ts:41`, `platform/apps/server/src/self-healing/default.ts:82`, `platform/apps/server/src/delivery/default.ts:106`                                                                                           |
| F-004 | P2       | Low        | False positive / documented local defaults | Secret and connection-string selector hits were docs, examples, tests, docker-compose, or local-dev fallbacks. Production env fail-fast is already covered by existing env tests.                                                                                                                    | `platform/apps/server/src/env.ts`, `platform/apps/server/test/unit/env-production-readiness.test.ts`, `platform/.env.example`                                                                                                                           |
| F-005 | P2       | Low        | False positive                             | Public route files without `requireIdentity` were intentional read-only or signature/OAuth entry points: Google auth start/callback/status, opt-in public dogfood, sample console, health/status. Mutating workspace routes either use `requireIdentity` or `resolveIdentity` with workspace checks. | `platform/apps/server/src/routes/google-auth.ts`, `platform/apps/server/src/routes/public-dogfood.ts`, `platform/apps/server/src/routes/sample.ts`, `platform/apps/server/src/routes/agents.ts`                                                         |
| F-006 | P1       | High       | Cleared                                    | Send/spend approval-gate behavior remained unchanged. Approval-gate selectors were reviewed around executor registration and money/send actions; this PR touches no approval runtime or policy files.                                                                                                | `platform/apps/server/src/approvals/runtime.ts`, `platform/apps/server/src/approvals/policy.ts`                                                                                                                                                         |
| F-007 | P0       | High       | Remediated, focused-test verified          | DNS rebinding / TOCTOU remained after the first SSRF fix because validation resolved one IP but the later fetch could perform a second independent DNS lookup. Fetches now use an undici dispatcher with a custom lookup pinned to the validated IP for onboarding and live site-reader requests.    | `platform/apps/server/src/security/public-web-url.ts:211`, `platform/apps/server/src/onboarding/deliverable.ts:144`, `platform/apps/server/src/marketing/site-reader/provider.ts:113`, `platform/apps/server/test/unit/public-web-url.test.ts:30`       |
| F-008 | P1       | High       | Remediated, focused-test verified          | NAT64 well-known prefix addresses could embed private IPv4 targets without passing through the IPv4 blocklist. The IPv6 guard now detects `64:ff9b::/96`, extracts the embedded IPv4 address, and applies the existing IPv4 private/reserved checks.                                                 | `platform/apps/server/src/security/public-web-url.ts:134`, `platform/apps/server/test/unit/public-web-url.test.ts:11`                                                                                                                                   |
| F-009 | P2       | Medium     | Remediated, focused-test verified          | The live site reader buffered the full body with `res.text()` before slicing to the byte cap, enabling memory pressure from very large or infinite responses. Shared response reading now checks `content-length`, streams via `getReader()`, and cancels when the byte cap is exceeded.             | `platform/apps/server/src/security/public-web-url.ts:248`, `platform/apps/server/src/marketing/site-reader/provider.ts:131`, `platform/apps/server/src/onboarding/deliverable.ts:171`, `platform/apps/server/test/unit/site-reader-service.test.ts:121` |

## Attack Chains

- AC-001, P0 pre-remediation: unauthenticated `GET /onboarding/deliverable?url=...` plus attacker-controlled DNS or redirect target could make the server fetch private/reserved hosts such as `169.254.169.254`. This is now blocked by DNS resolution, private/reserved IP rejection, numeric-host rejection, port allow-listing, and manual redirect-hop validation.
- AC-002, P1 pre-remediation: authenticated owner sets or configures a marketing target URL, `marketing.readSiteContent` is enabled for the owner workspace, then a launch enriches a task by crawling that target. A private seed or redirect could reach internal services. This is now blocked by the same shared guard before the seed fetch and at every redirect hop.
- AC-003, P0 pre-remediation follow-up: an attacker-controlled hostname could return a public IP during validation and then a private IP during the fetch lookup. The validated URL target now carries the approved address into a pinned undici lookup, so the socket connects to the same IP validation approved.
- No confirmed auth-bypass plus ID-gated action chain was found. Workspace-mutating route hits either use `requireIdentity` or `resolveIdentity` and compare the route workspace id to the caller workspace.
- No send/spend approval bypass chain was found. This branch intentionally does not modify approval behavior.

## Remediation

Implemented in this branch:

- Added `platform/apps/server/src/security/public-web-url.ts` with DNS resolution, private/reserved IPv4 and IPv6 blocking, numeric host literal rejection, and `http`/`https` port restrictions limited to 80/443.
- Refactored `platform/apps/server/src/onboarding/deliverable.ts` to use the shared guard before the first fetch and on every redirect hop.
- Refactored `platform/apps/server/src/marketing/site-reader/provider.ts` to reject private seeds before fetch and to use manual redirect handling with validation on each hop.
- Expanded SSRF tests in `platform/apps/server/test/unit/onboarding-deliverable.test.ts` and `platform/apps/server/test/unit/site-reader-service.test.ts`.
- Follow-up hardening: `validatePublicWebUrl` now returns the validated hostname plus pinned IP, `fetchPinnedPublicWebUrl` passes an undici dispatcher whose lookup returns only that IP, and both onboarding and live site-reader callers use it for the first request and every redirect hop.
- Added `64:ff9b::/96` NAT64 embedded-IPv4 checks to the IPv6 guard.
- Added `readPublicWebResponseText` to enforce `content-length` and streaming byte caps before buffering remote response bodies.
- Preserved #1530 honesty for broken sites: HTTP-error homepages, including Wix-style 404 HTML, now return an explicit HTTP-status snapshot before any 404 body parsing can look like a real customer deliverable.

Blocked ranges covered in tests: `0/8`, `10/8`, `127/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`, `fc00::/7`, IPv4-mapped metadata addresses, and NAT64 embedded private IPv4 addresses. Numeric host tests cover decimal, hex, abbreviated dotted forms, and non-standard ports.

## Verify

| Check                                                                                                                                                                                                                    | Result                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Selector rerun: `node scripts/security-swarm.mjs >/tmp/security-swarm-followup.json`                                                                                                                                     | Pass                                                                                                                                    |
| Lint: `pnpm -C platform lint`                                                                                                                                                                                            | Pass                                                                                                                                    |
| Focused unit tests: `pnpm -C platform --filter @reload/server exec vitest run --config vitest.config.ts test/unit/public-web-url.test.ts test/unit/onboarding-deliverable.test.ts test/unit/site-reader-service.test.ts` | Pass: 45 tests                                                                                                                          |
| Coordinator flaky-test guard: `pnpm -C platform --filter @reload/server exec vitest run --config vitest.config.ts test/unit/team-coordinator.test.ts --reporter=dot`                                                     | Pass: 29 tests                                                                                                                          |
| Server unit suite: `pnpm -C platform --filter @reload/server exec vitest run --config vitest.config.ts test/unit --reporter=dot`                                                                                         | Pass: 708 files / 6,345 tests                                                                                                           |
| Server typecheck: `pnpm -C platform --filter @reload/server typecheck`                                                                                                                                                   | Pass                                                                                                                                    |
| Server build: `pnpm -C platform --filter @reload/server build`                                                                                                                                                           | Pass                                                                                                                                    |
| Whitespace: `git diff --check`                                                                                                                                                                                           | Pass                                                                                                                                    |
| Compiled-output repro                                                                                                                                                                                                    | Pass: NAT64 private target not fetched; pinned dispatcher present; private redirect blocked; Wix-style 404 returns honest HTTP snapshot |

Compiled-output repro command:

```sh
node --input-type=module <<'NODE'
import { readSiteSnapshot } from './platform/apps/server/dist/onboarding/deliverable.js';
import { LiveSiteReaderProvider } from './platform/apps/server/dist/marketing/site-reader/provider.js';
import { createPinnedPublicWebLookup, validatePublicWebUrl } from './platform/apps/server/dist/security/public-web-url.js';

const nat64Resolver = async () => [{ address: '64:ff9b::10.0.0.1', family: 6 }];
let nat64FetchCalls = 0;
const nat64 = await readSiteSnapshot(
  { url: 'https://nat64-private.example', host: 'nat64-private.example', name: 'Nat64' },
  async () => {
    nat64FetchCalls += 1;
    return new Response('<title>bad</title>', { status: 200, headers: { 'content-type': 'text/html' } });
  },
  nat64Resolver,
);
if (nat64 !== null || nat64FetchCalls !== 0) throw new Error('NAT64 private target was fetched');

const pinnedTarget = await validatePublicWebUrl('https://public.example/', async () => [
  { address: '93.184.216.34', family: 4 },
]);
if (!pinnedTarget) throw new Error('public target did not validate');
const lookup = createPinnedPublicWebLookup(pinnedTarget);
await new Promise((resolve, reject) => {
  lookup('public.example', {}, (err, address, family) => {
    if (err) return reject(err);
    if (address !== '93.184.216.34' || family !== 4) return reject(new Error('lookup did not pin validated IP'));
    resolve(undefined);
  });
});
let sawDispatcher = false;
const pinned = await readSiteSnapshot(
  { url: 'https://public.example', host: 'public.example', name: 'Public' },
  async (_url, init) => {
    sawDispatcher = Boolean(init?.dispatcher);
    return new Response('<title>Public</title><h1>Public launch</h1>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  },
  async () => [{ address: '93.184.216.34', family: 4 }],
);
if (!pinned || !sawDispatcher) throw new Error('fetch did not receive pinned dispatcher');

const redirectResolver = async (hostname) =>
  hostname === 'private.example'
    ? [{ address: '10.0.0.7', family: 4 }]
    : [{ address: '93.184.216.34', family: 4 }];
let redirectFetchCalls = 0;
const pages = await new LiveSiteReaderProvider(undefined, undefined, redirectResolver, async () => {
  redirectFetchCalls += 1;
  return new Response(null, { status: 302, headers: { location: 'http://private.example/admin' } });
}).fetchPages('https://public.example/');
if (pages.length !== 0 || redirectFetchCalls !== 1) throw new Error('private redirect hop was not blocked');

const httpError = await readSiteSnapshot(
  { url: 'https://getfoolish.com', host: 'getfoolish.com', name: 'Getfoolish' },
  async () =>
    new Response('<title>Page not found | Wix.com</title><h1>This domain is not connected</h1>', {
      status: 404,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
  async () => [{ address: '93.184.216.34', family: 4 }],
);
if (!httpError || httpError.title !== 'HTTP 404 from getfoolish.com') {
  throw new Error('HTTP-error homepage did not produce honest status snapshot');
}

console.log('compiled security follow-up repro passed');
NODE
```

## Notes For The Next Run

- Persisting the full signal JSON is intentionally skipped because it is large and reproducible from `scripts/security-swarm.mjs`.
- If claim producers are added for verifiers or self-healing accepts customer-written URLs, promote F-003 from P2/inconclusive and wire those probes through `validatePublicWebUrl`.
- Re-run the swarm after major route additions or provider integrations; selectors are versioned and can be diff-scanned.
