# Agentic MapReduce Security Threat Model

Issue: #1553
Reference: https://devin.ai/blog/agentic-map-reduce
Scope: the full \`gagan114662/agent-skills\` repository, with deeper security attention on \`platform/\`.

## Assets

- Workspace, member, channel, approval, billing, deploy, and agent-run data in Postgres.
- Secrets in environment variables and service credential vault flows.
- Owner approval boundaries for send/spend/deploy/connection actions.
- Public onboarding and demo endpoints that fetch or transform untrusted input.
- Messaging-channel webhooks and room mirrors for Telegram, WhatsApp, Slack, and iMessage.

## Trust Boundaries

- Public unauthenticated routes: health/status/site/onboarding/demo/contact/webhook surfaces.
- Authenticated user routes: \`requireIdentity(req, reply)\` establishes caller identity.
- Tenant-scoped routes: \`assertWorkspace(identity, wid, reply)\` must guard \`:wid\` resource access.
- External fetch/deploy/provider clients: outbound HTTP reaches third-party APIs or user-controlled URLs.
- Shell/process helpers: git, Postgres dump/restore, and verification helpers execute local binaries.
- Browser-facing code: API clients parse JSON and render server-provided strings.

## Selectors

Selectors are intentionally lexical and deterministic so the scan is reproducible without a model in the loop.
Each match emits a signal containing \`selector\`, \`path\`, \`line\`, and an evidence snippet. Non-matching files are
dropped before the map stage.

| Selector                | Pattern family                                                                             | Security question                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| \`route-declaration\`   | Fastify \`app.get/post/put/patch/delete\` and \`.route(\`                                  | Does the route have the intended public/auth/tenant boundary?                             |
| \`auth-boundary\`       | \`requireIdentity\`, \`assertWorkspace\`, auth cookies/tokens                              | Are authenticated and tenant-scoped paths guarded consistently?                           |
| \`outbound-fetch\`      | \`fetch(\`, provider HTTP calls, URL construction                                          | Can user input influence outbound hosts, redirects, or ports?                             |
| \`ssrf-url-parse\`      | \`new URL\`, hostname parsing, DNS lookup, redirect handling                               | Are URL fetches normalized and checked before network access?                             |
| \`dns-rebinding-pin\`   | validated public URL targets, custom \`dispatcher\`/\`lookup\`/\`connect\` controls        | Does the actual socket use the same IP address that URL validation approved?              |
| \`nat64-bypass\`        | NAT64 \`64:ff9b::/96\`, IPv4-mapped/compatible IPv6, embedded IPv4 extraction              | Do IPv6 forms that tunnel IPv4 still pass through the IPv4 private/reserved range checks? |
| \`unbounded-buffering\` | \`res.text()\`, \`arrayBuffer()\`, \`getReader()\`, \`content-length\`, response byte caps | Are remote response bodies capped before buffering so crawlers cannot OOM the server?     |
| \`deserialization\`     | \`JSON.parse\`, YAML/deserialization entry points                                          | Is untrusted structured input bounded and validated after parse?                          |
| \`dangerous-api\`       | \`spawn\`, \`exec\`, \`eval\`, \`new Function\`, dynamic import-like execution             | Can attacker-controlled input reach process execution or code execution?                  |
| \`secret-env\`          | \`process.env\`, token/key/secret/password vars, connection strings                        | Are secrets required in production and kept out of responses/logs?                        |
| \`approval-gate\`       | approval action names and executor registration                                            | Are send/spend/deploy actions still parked behind human approval?                         |
| \`cors-origin\`         | CORS origin and public app origin handling                                                 | Are browser-origin boundaries permissive only in safe contexts?                           |
| \`console-log\`         | server \`console.log/warn/error\`                                                          | Do logs risk leaking tokens or user content?                                              |

## Map False-Positive Gate

A signal is cleared when one of these is true:

- It is test-only, fixture-only, generated output, or documentation-only.
- The route is intentionally public and has no side effect or sensitive data disclosure.
- The outbound URL is a static provider endpoint or validated before fetch.
- Parsed JSON is from a trusted local file, already schema-checked, or used only in tests.
- Process execution uses fixed binaries/arguments or validates caller-controlled fields first.
- Secret/env handling only reads variable names and does not log or return values.

## Severity

- P0: unauthenticated or cross-tenant data/action compromise, SSRF to internal services, remote code execution, or approval-gate bypass for send/spend.
- P1: exploitable sensitive-data leak, confused-deputy external calls, serious production misconfiguration, or high-confidence chain requiring auth.
- P2: hardening gap, low-confidence issue, missing regression coverage, or bounded denial-of-service risk.

## Verification Standard

P0/P1 findings must be reproduced against a local running build or a focused unit/integration harness. Findings are
marked \`Confirmed\`, \`False Positive\`, \`Inconclusive\`, or \`Remediated\`. The first run must cover the onboarding SSRF
reported from PR #1546 and verify DNS resolution, private/reserved IP blocking, numeric-host blocking, redirect-hop
checks, and port restrictions.
