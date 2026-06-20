# ADR-0400: Inbound lead capture — the autonomous loop's inbound mouth

- **Status:** Accepted (GAP 1 of the leads centre — capture route + table + discovery feed + wired form)
- **Date:** 2026-06-19
- **Context task:** Leads centre GAP 1 (see `/tmp/leads-centre-gaps.md`, Step 0). The public landing form
  ("what are you hoping the fleet can do?") was **client-only**: on submit it set a `sent` flag and showed
  a candid note that no backend was wired. There was no public inbound endpoint and no leads table, so
  **every inbound lead from the public site was silently dropped**. The fully-autonomous lead→payment loop
  had no inbound mouth.
- **Builds on:** ADR-0222 (#222 customer discovery engine — the `ingestSignal` seam an inbound lead feeds),
  ADR-0190 (#190 support desk — the public signed-inbound-hook route style we mirror, minus the HMAC),
  ADR-0200 (premortem rails — inbound body is untrusted DATA, no money path, no irreversible action),
  ADR-0099 (migration numbering by a free prefix to dodge sibling-workspace collisions),
  ADR-0155 (the colocation gate — the table is deliberately not a governed-metric-prefixed name).

## Context

GAP 1 is HIGH-leverage and SAFE: capturing a lead spends no money, sends nothing outbound, and triggers no
new #13 action. The smallest fix that makes the form actually work is a public capture endpoint + a
workspace-scoped table + a best-effort discovery feed so a captured lead becomes a ranked discovery
prospect the fleet can work.

## Decision

Add an additive, workspace-scoped `inbound_leads` table and a single PUBLIC (unauth) `POST /inbound/leads`
route, wire the landing `ContactForm` to it, and best-effort feed each capture into the #222 discovery
engine. Capture is **ON by default** — there is no off-by-default gate that could leave the form broken;
the only condition is having a workspace to attribute the lead to.

- **Schema/migration** (`db/schema/inbound-leads.ts`, `drizzle/0400_inbound_leads.sql`): `inbound_leads`
  (`id`, `workspace_id` FK CASCADE, `name`, `email`, `message`, `source` default `landing_form`,
  `tracking_ref` nullable — reserved for #386 attribution, `status` default `new`, `created_at`), indexed by
  `(workspace_id, created_at)`. Numbered **0400** by a free prefix (per ADR-0099). The name is deliberately
  NOT `tenant_usage`/`venture_`/`growth_`/`demand_`/`moat_`-prefixed so the #155 colocation gate does not
  class it as a governed metric surface — it is a CRM intake row, not a metric.
- **Repository** (`db/repositories/inbound-leads.ts`): `recordLead` (a simple insert returning id — every
  hand-raise is real, no dedup) and `listLeads(workspaceId, sinceMs?)`, workspace-scoped throughout (#3).
- **Pure helper** (`leads/inbound.ts`, fully unit-tested): `sanitizeLead` (#200 §6 — strips C0/C1 control
  characters, collapses whitespace, hard-caps lengths, validates a conservative email shape, rejects empty
  email/message, allow-lists `source`, and only persists a ref-shaped `trackingRef`) and `toDiscoverySignal`
  (maps a lead → a `role_identified` signal; the prospect key is an OPAQUE hash of the email — discovery
  refuses an email-looking key, so no PII reaches the discovery layer).
- **Route** (`routes/inbound-leads.ts`): resolves the target workspace as the marketing-owner workspace
  (`marketing.ownerWorkspaceId`); a `workspaceId` in the body is honored ONLY when it exactly matches the
  owner (the public form can never aim a lead at another tenant). Validates + sanitizes the body, persists
  the lead FIRST, then best-effort feeds discovery — **a discovery hiccup never fails the capture** (the
  lead is already durable). Returns `202 {received:true}`; rejects empty email/message with 400; 503s until
  an owner workspace is configured.
- **Web** (`components/landing/ContactForm.tsx`): POSTs to `/inbound/leads` with sending / sent / error
  states; all copy from `brand.ts` `CONTACT` (the `sentNote` is now honest — the lead really persists).

## Consequences

- The public landing form now captures real leads instead of dropping them; the autonomous loop has an
  inbound mouth feeding #222.
- **No money, no outbound send, no new #13 action.** The inbound body is untrusted DATA throughout.
- `tracking_ref` is reserved (nullable) for the #386 attribution "slice 3" follow-up (GAP 2/4), so a future
  payment can credit the lead that produced it.
- Capture is ON wherever the deployment names its own workspace (it already does for the dogfood marketing
  fleet); other deployments 503 the public route until an owner is configured.
