# ADR-0267: Central provisioning of paid data, posting and ads APIs (customer never sees a key)

- **Status:** Accepted (shipped in PR for #267)
- **Date:** 2026-06-17
- **Context issue:** [#267](https://github.com/gagan114662/agent-skills/issues/267) — real keyword/SERP
  data, social posting, and ads management sit behind paid third-party APIs that need keys and approvals.
  ipop should hold these CENTRALLY and bill them into the plan so customers never provision or see an API
  key. Only the customer's OWN spend — ad budget, email-sending tier — stays a money-gated yes. Acceptance:
  Scout gets real keyword data and Echo posts socially without the user entering any API key.
- **Builds on:** [ADR-0068](0068-tenant-credentials-vault.md) (the sealed per-tenant credentials vault this
  reuses), [ADR-0192](0192-external-account-onboarding.md) (the write-only `external_credentials` vault +
  `resolveServiceSecrets` read-back — the central keys live there under `central:<provider>` in the OWNER
  workspace), [ADR-0258](0258-connect-once-integrations.md) (the connect-once model — a customer connects
  their own social/site account via OAuth; this is the orthogonal "ipop holds the PAID API key" half),
  [ADR-0243](0243-money-only-approval.md) (the money-only #13 gate — only the customer's own spend pauses),
  [ADR-0280](0280-reach-outbound.md) (the paid-data-source pattern this generalises), [ADR-0223](0223-decision-maker-resolver.md)
  (the quarantine-untrusted-input injection defense), [ADR-0035](0035-config-layering.md) (the layered
  feature-flag config), [ADR-0200](0200-premortem-panel.md) (the standing premortem this answers to).
- **Scope:** this PR ships the **shared provisioning SEAM** — the model + the runtime resolver + the money
  boundary + the usage ledger. The per-department adapters that wire a REAL provider behind it
  (#265/#268/#269/#270/#272) are deliberately out of scope; they extend the catalog and call the seam.

## Context

Today every paid-API capability the fleet needs is either missing or modelled per-tenant: #192 has the
customer PASTE their own keys, and #280 money-gates the customer buying their own prospect-data credits.
That is the wrong shape for keyword/SERP data, social posting infra, and the ads-management API: those are
ipop's **cost of goods**. ipop should hold ONE key per provider centrally, bill the cost into the plan, and
let a non-technical customer get "real keyword data" without ever seeing — or money-approving — an API key.

The standing premortem (#200) sets the rails: an "it happened" claim must rest on an **external receipt**
(§2); verification must be **production-grounded** (§3); **irreversible/money** actions are **pre-committed
+ human-gated** (§4); and a poisoned web read must never steer an autonomous write (§6). Paid data APIs
return untrusted, web-derived content, so §6 is load-bearing here.

## Decision

Add a **central provisioning seam** (`src/provisioning/`) every department resolves a paid capability
through. It is **default-OFF, owner-workspace-first**, holds **no key in code/config**, and encodes the
issue's money rule as data.

1. **Catalog** (`provisioning/registry.ts`, pure). Names CAPABILITIES (`keyword_data`, `serp_data`,
   `social_post`, `ads_manage`, `ads_spend`, `email_send_tier`) and, for each, a `costClass` and the
   provider ids that can fulfil it (NAMES only, never secrets). `centralServiceKey(provider)` derives the
   vault key `central:<provider>` — namespaced so it can never collide with a customer paste. The catalog
   is the single place the per-department PRs extend with a real provider id.

2. **Money boundary as data** (`costClass`). `platform_cost` (keyword/SERP data, social-posting infra, the
   ads-management API) is ipop's cost of goods, billed into the plan → used **AUTONOMOUSLY** (no #13 gate).
   `customer_spend` (the customer's OWN ad budget, their email-sending tier) is real, irreversible money
   (§4) → **ALWAYS** owner-gated through the new `provisioning.customer_spend` money action (added to
   `MONEY_ACTIONS` + `IRREVERSIBLE_ACTIONS` in `approvals/policy.ts`). `decideProvision` returns
   `requiresApproval: true` for a customer-spend capability **even when the provisioning flag is off** — the
   customer's money is never autonomous; the gate is intrinsic to the cost class, not the feature flag.

3. **Pure routing brain** (`provisioning/decide.ts`). `decideProvision(capabilityId, caps, workspaceId)`
   returns `unknown` (fail closed) / `customer_spend` (money-gated, no key) / `disabled` (flag off → adapter
   falls back to mock) / `provisioned` (which provider, which central vault key, autonomous). The decision is
   a pure function of the **structural** capability id + workspace flags — it **never inspects a provider
   response or agent free text** (injection defense, §6), so a poisoned read can never redirect which
   provider/credential is used nor flip the money gate.

4. **Default-OFF, owner-workspace-first gate** (`provisioning/caps.ts`). `resolveProvisioningCaps` hard-
   defaults the partial; `isProvisioningEnabledForWorkspace` is two-pronged — the master flag must be on
   AND the workspace in scope (`ownerWorkspaceOnly` defaults true ⇒ only the named owner workspace;
   turning the flag on without naming it provisions to **nobody**, the safest default). Mirrors `delivery`.

5. **Server-side central credential resolver** (`provisioning/provider.ts` + `service.ts`). The ONLY
   read-back of a centrally-held key is `CentralCredentialResolver.resolveCentral(provider)`, which reads
   `central:<provider>` from the **OWNER workspace** vault (`resolveServiceSecrets`) — never the customer's,
   never pasted by the customer. It is consumed only by `ProvisioningService.resolveCredential`
   server-side (like `BillingSecretsResolver` for Stripe), so a central key is **never merged into an agent
   env passthrough** and never returned to a user-facing route. An un-connected key degrades to
   `unavailable` (the adapter falls back to mock) — never a throw, never a leak.

6. **Key-free read surface** (`GET /me/provisioning`). Shows the customer "real keyword data: billed into
   your plan, no API key needed" using only a boolean connected-flag from the vault STATUS API (which never
   selects the secret column) + the structural provider id. A unit test asserts the serialized status
   carries no key material. There is deliberately **no connect/paste endpoint** — the customer never
   provisions a key.

7. **Usage ledger** (`provisioning_usage`, migration 0267). How ipop "bills the cost into the plan":
   `ProvisioningService.meter` records one row per use (capability, provider, units, cost of goods, optional
   external receipt). Premortem §2: a row is `verified` only when it carries a non-empty `external_ref`
   (derived at write time, never client-asserted); `verifiedCostCents` sums only verified rows, so an
   estimate never drives a hard billing number. The table is non-governed (not `venture_/growth_/demand_/
   moat_`-prefixed) so the #155 colocation gate does not class it a metric surface.

8. **Injection quarantine** (`provisioning/quarantine.ts`). The structural boundary a per-department adapter
   wraps an untrusted provider RESPONSE in before handing it to the fleet. A `QuarantinedProviderResult` is
   inert DATA carrying the **caller-supplied** structural provider id (never one parsed from the body) and a
   sanitized payload — it exposes no action, mirroring the #223 `QuarantinedProfileReader`.

All of it is default-OFF: with no `provisioning.enabled` set (config or `RELOAD_PROVISIONING_ENABLED`), every
capability resolves `disabled`, no vault is read, and the read surface shows everything "not provisioned".

## Consequences

- **The seam is ready for the per-department PRs.** #268 (Scout keyword/SERP) and #269/#270 (Echo posting,
  Bid ads) resolve a credential with one `service.resolveCredential(ws, capability)` call, meter usage with
  one `service.meter(...)`, and quarantine the response with one wrap — without re-modelling provisioning,
  the money gate, or the vault.
- **Customer never sees — or money-approves — a key.** The only secret read is server-side against the
  OWNER vault; the customer-facing route is boolean-only; `platform_cost` runs with no #13 prompt. The
  customer's OWN money still ALWAYS gates (`provisioning.customer_spend` ∈ `MONEY_ACTIONS`).
- **Premortem honoured.** Metrics rest on external receipts (§2, the `verified` ledger); the connected-key
  check is a real vault read (§3); customer money is pre-committed + human-gated + counted irreversible
  (§4); untrusted provider input is quarantined and routing is structural (§6).
- **No live calls, no real credentials.** This PR contains no provider key and makes no network call: the
  default provider is the free `mock`, and a real adapter/provider id arrives in a later PR behind the same
  default-OFF flag. Migration `0267_provisioning_usage` is additive and reversible.

## Alternatives considered

- **Reuse #192 per-tenant paste for everything.** Rejected: it makes the non-technical customer paste a key
  and (under #280) money-approve their own data spend — exactly what #267 removes for ipop's cost of goods.
- **Inject central keys into the agent runtime env.** Rejected: that puts a shared platform key in every
  customer session's environment. The seam resolves server-side only (the `BillingSecretsResolver`
  precedent), so the per-department adapter makes the call and hands back quarantined data.
- **One blanket "paid APIs on" switch.** Rejected for owner-workspace-first: ipop dogfoods provisioning in
  its own workspace before broadening (`ownerWorkspaceOnly`), bounding blast radius (§4).
