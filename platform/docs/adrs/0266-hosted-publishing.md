# ADR-0266: ipop hosted publishing — customer blogs + landing pages with zero repo

- **Status:** Accepted (shipped in PR for #266)
- **Date:** 2026-06-17
- **Context issue:** [#266](https://github.com/gagan114662/agent-skills/issues/266) — *"Publishing must not involve
  GitHub, repos or PRs for a customer. ipop hosts the customer blog and landing pages multi-tenant, served
  on the customer's own domain via the automated DNS flow or an ipop subdomain. Agents create and edit pages
  directly. The GitHub path stays only as ipop's internal mechanism for ipop.ai."*
- **Acceptance:** Quill publishes a live article on a customer domain with no repo and no deploy the user can see.
- **Builds on:** [ADR-0013](0013-approval-gates.md) (#13 approval queue — the owner gate), [ADR-0295](0295-deliverable-delivery.md)
  (the approve→ship dispatcher pattern this mirrors), [ADR-0231](0231-real-world-tool-surface.md) (the `realworld.publish`
  park-PENDING gate), [#252](https://github.com/gagan114662/agent-skills/issues/252) (the SEO/escaping/JSON-LD
  render discipline reused), [ADR-0264](0264-dns-automation-cloudflare.md) (the DNS-verify seam a custom domain is
  served behind), [ADR-0243](0243-money-only-approval.md)
  (money-only autonomy — and why #266 deliberately overrides it).

## Context

Today the only "publish a page" path is the #250/#258 `SitePublisher` seam: it commits a file and opens a
**GitHub PR** against a repo. That is ipop.ai's own internal mechanism and is fine for ipop — but a customer
must never see a repo, a PR, a token, or a deploy. #266 needs ipop to **host** a customer's blog + landing
pages multi-tenant, served on the customer's own domain (via the #264 DNS flow) or on a free ipop subdomain,
with agents creating/editing pages directly.

The standing premortem (#200) frames the hard constraints, restated by the issue brief:

- **§4 nothing irreversible-by-surprise / nothing live without the owner.** A published page is an outward
  brand surface on a customer's domain. So **every publish goes through the #13 owner approval** — drafted and
  queued, never autonomous. This *overrides* the #243 money-only default (publishing is money-free, but the
  issue's hard constraint makes it owner-gated anyway).
- **§4 reversibility.** A published page can always be pulled (`unpublish`).
- **§6 injection.** A page's title/body/description are USER DATA an agent may have folded a poisoned web read
  into. They must never become live markup/script, and must never be parsed to choose a route/target.
- **§2 metrics rest on receipts.** Page-view counts come only from recorded view rows, never self-report.
- **Default-OFF, owner-workspace-first** (§5 owner attention) and **no credentials/Stripe/live sends.**

The #252 prerender pipeline was considered for reuse but rejected: it is a **single-tenant build-time** path
(it statically renders ipop.ai's own Landing + committed blog markdown into `dist/index.html` at `vite build`).
Multi-tenant customer pages, created/edited at runtime on arbitrary domains, cannot be a build artifact. So
#266 builds a **server-side render+serve path** that *reuses the #252 discipline* (HTML escaping, canonical +
Open Graph + JSON-LD, deterministic output) rather than its build machinery.

## Decision

Build hosted publishing as its **own module** (`src/hosted/`) and surface (`/me/hosted/*` + a public serve
route), leaving the GitHub `SitePublisher` seam untouched as ipop.ai's internal mechanism. The lifecycle:

```
draftPage  ──►  requestPublish  ──►  [#13 owner approval]  ──►  executePublish  ──►  serve
(autonomous,    (ALWAYS parks a       (the only gate;          (post-approval        (published
 invisible)      pending request)      owner approves)          ONLY, fail-closed)    pages only)
                                                                       │
                                                                  unpublish (reversible)
```

### Where each piece lives

- **`hosted/decide.ts` (pure):** `resolveHostedSitesFlags` (default-OFF, owner-workspace-first — a byte-for-byte
  copy of the #295 delivery resolver), `decideHostedPublish` (validates a request, derives a traversal-proof
  `[a-z0-9-]` slug — reads content ONLY for emptiness/slugify, never to choose a route), and the kind/status enums.
- **`hosted/render.ts` (pure):** `renderHostedPage` — the injection chokepoint. Every user field is HTML-escaped;
  the body renders as escaped paragraphs (never raw HTML); the JSON-LD block escapes `<`/`>`/`&` so a `</script>`
  in the content can't break out. Output is a complete, deterministic document (doctype + head + canonical + OG +
  JSON-LD), so the bytes a unit test renders are the bytes the serve path returns — "renders/serves correctly in
  a real build" is checkable without a browser.
- **`hosted/domain.ts` (pure):** `resolveHostedUrl`/`resolveHostedHost` — a verified custom domain (#264) else the
  free `<subdomain>.sites.ipop.app`. The URL builder THROWS on an unsafe slug (defense in depth).
- **`hosted/service.ts`:** `HostedPublishService` — the lifecycle. `requestPublish` ALWAYS parks a #13 request
  (the hard constraint — there is no autonomous publish path). `executePublish` runs ONLY from the post-approval
  dispatcher and is **fail-closed on a missing approval id** (the #295 invariant). `serve` returns only a
  `published` page and records a real view receipt. `summary` reports published-page + view counts from rows only.
- **`hosted/dispatcher.ts`:** `createHostedPublishDispatcher` — mirrors the #295 `DeliveryDispatcher` exactly: the
  owner's approval is the ship trigger; routing is structural (the page id off the approval payload, never the
  content); fail-closed on empty approval id / feature-OFF / missing page id.
- **`approvals/` wiring:** `HOSTED_PUBLISH_ACTION = "hosted.publish"` (policy.ts), `validateHostedPublish`
  (executor.ts), and `makeHostedPublish(dispatcher)` registered in `buildDefaultRegistry` (a new optional 5th
  param) — wired into `buildAcquisitionRegistry` (the registry the #13 approval route actually uses) and the
  `defaultRegistry`. Without a dispatcher the executor is a pure acknowledgement, so every existing approval test
  is byte-for-byte unchanged.
- **Storage:** migration `0266_hosted_publishing.sql` — `hosted_sites`, `hosted_pages`, `hosted_page_views`.
  `approval_request_id` on `hosted_pages` is the load-bearing proof a page only reached `published` through an
  approval. Names are NOT `venture_`/`growth_`/`moat_`-prefixed, so the #155 colocation gate is not tripped.
- **Config:** a new `hostedSites` block (schema.ts + layers.ts + loader.ts), default-OFF owner-first, env
  `RELOAD_HOSTEDSITES_*` (owner marker reuses the #258 `RELOAD_MARKETING_OWNER_WORKSPACE_ID`).

### Why the `SitePublisher` seam is not reused for the customer path

`SitePublisher.publish(req)` carries no requester or approval context — it models an *autonomous* GitHub-PR. The
hosted flow is draft → owner-approval → serve, which needs a requester (to park the #13 request) and an approval
id (to authorize the live publish). Forcing the hosted flow through that seam would invent coupling and a
dishonest "published" result for a page that is only *queued*. So `IpopHostedSitePublisher` stays a not-connected
placeholder on that seam (its docstring points here), and customer hosting is reached through the dedicated
module. This is the "own modules, reuse seams" directive read correctly: the seams reused are the #13 queue, the
#252 render discipline, and the #264 DNS-verify — not the PR-shaped publisher.

## Consequences

- **Nothing goes live without an explicit owner approval.** The service has no autonomous publish path; the only
  thing that flips a page to `published` is the post-approval dispatcher, fail-closed on a missing approval id.
- **Reversible + injection-safe + externally-grounded** by construction (unpublish; escaped render with a
  structural router; view metrics from receipts only).
- **Default-OFF, owner-workspace-first, no credentials.** A fresh deployment hosts nothing; a free ipop subdomain
  hosts immediately once enabled; a custom domain is served only after #264 verifies control.
- **No metric-surface or governed table touched** → colocation stays green, no sibling-workspace migration
  collision (numbered 0266 by issue per ADR-0099).
- **Acceptance met end-to-end** (pure → service → #13 gate → dispatcher → serve): an agent drafts an article, the
  owner approves, the page serves live on the customer's domain — no repo, no PR, no deploy the customer sees.
