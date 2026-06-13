# Spec — Legal & Compliance Pack per venture (#196)

See [ADR-0196](../adrs/0196-legal-compliance-pack.md) for the decision record. This spec is the
implementation map.

## Module layout (`apps/server/src/legal/`)

| File | Kind | Responsibility |
| --- | --- | --- |
| `types.ts` | data | Shared types (facts, documents, compliance, naming, regulated, data rights). |
| `disclaimer.ts` | const | The non-counsel disclaimer rails (document footer + agent rail + hard-stop notice). |
| `caps.ts` | pure | `resolveLegalCaps` / `LEGAL_DEFAULTS` — **default OFF**. |
| `generate.ts` | pure | `composeDocument` / `composePack` / `fingerprintFacts` / `isMaterialChange`. |
| `compliance.ts` | pure | `decideCompliance` — CAN-SPAM/CASL/GDPR rule (suppression → footer → consent). |
| `precheck.ts` | pure | `NamingPrecheck` interface + `deterministicNamingPrecheck` stub. |
| `regulated.ts` | pure | `assessRegulated` + `decideNamingDisposition` (regulated → hard_stop). |
| `service.ts` | IO seams | `LegalService` — orchestrator; every collaborator injected. |
| `enforcer.ts` | IO | `defaultComplianceEnforcer` — the production `ComplianceEnforcer` (default-OFF no-op). |
| `default.ts` | wiring | `createDefaultLegalService` — DB repos + #13 gate + deterministic precheck. |

Supporting: `db/schema/legal.ts` (6 tables), `db/repositories/legal.ts`, `routes/legal.ts`,
`drizzle/0196_legal_compliance_pack.sql` (+`.down.sql`). Send-layer enforcement plugs into
`approvals/runtime.ts` (`makeExternalSend` + `buildDefaultRegistry`).

## Acceptance criteria → implementation

1. **Docs per venture (generated, versioned, published, regen-on-change, owner-review).**
   `composeDocument` renders ToS/privacy from `venture_legal_facts`; content-hash `version` +
   `sourceFactsHash`. `LegalService.generate` persists drafts + opens ONE pending #13 publish approval.
   `regenerateIfChanged` detects facts drift vs the published baseline and (when `autoRegenerate`)
   regenerates + re-opens an approval. Pending approval ⇒ shows in the #173 decision queue with no new wiring.
2. **Email/marketing compliance in code.** `decideCompliance` (pure) + `defaultComplianceEnforcer` (IO) in
   the `makeExternalSend` chokepoint. Suppression list + CAN-SPAM footer + CASL/GDPR consent. Blocks the
   send; records `compliance_events`.
3. **Name/trademark pre-check.** `deterministicNamingPrecheck` (stub for #187) + `assessRegulated`;
   `runNamingPrecheck` attaches the verdict to a pending naming-decision approval. Route:
   `POST /workspaces/:wid/legal/naming-precheck`.
4. **Data rights.** `requestDataExport` / `requestDataDeletion` honor + audit (`data_rights_requests`);
   deletion suppresses the contact. Routes: `POST/GET /workspaces/:wid/legal/data-requests`.
5. **Disclaimer rails + regulated hard-stop.** `DOCUMENT_DISCLAIMER` baked into every generated doc
   (asserted by a test); `assessRegulated` → `hard_stop` carries `REGULATED_HARD_STOP_NOTICE` into the
   approval summary; can never auto-clear.

## Routes (all `requireIdentity` + `assertWorkspace`)

- `PUT/GET  /workspaces/:wid/ventures/:vid/legal/facts`
- `POST     /workspaces/:wid/ventures/:vid/legal/generate` → 202 + pending approval
- `GET      /workspaces/:wid/ventures/:vid/legal/documents`
- `POST     /workspaces/:wid/legal/naming-precheck` → 202 + pending approval
- `POST     /workspaces/:wid/legal/suppressions`
- `POST     /workspaces/:wid/legal/consent`
- `POST/GET /workspaces/:wid/legal/data-requests`

## Config (`legal` block — default OFF)

`enabled` (master switch — gates send-layer enforcement + auto-regen), `autoRegenerate`,
`requireConsentForEmail` (default ON, bites only when `enabled`). Registered in all 5 `config/schema.ts`
sites + both `config/layers.ts` merge fns. Owner-only rollout via a managed per-tenant override.

## Tables (migration 0196, additive, workspace-scoped, ON DELETE CASCADE)

`venture_legal_facts`, `legal_documents`, `email_suppressions`, `consent_records`, `compliance_events`,
`data_rights_requests`.

## Tests (`test/unit/legal-*.test.ts`)

`legal-generate` (deterministic, disclaimer, material-change), `legal-compliance` (every CAN-SPAM/CASL/GDPR
rule + precedence), `legal-precheck` (trademark/domain/regulated/disposition), `legal-caps` (default-OFF +
disclaimer rails), `legal-service` (generate→1 approval, IDOR 404, regen gating, naming hard-stop, data
rights), `legal-enforcer-runtime` (chokepoint allow/block, no-op default, egress-before-compliance),
`legal-config` (not-silently-dropped + owner-only managed override).

## Default-OFF guarantee

`legal.enabled !== true` ⇒ `ComplianceEnforcer` is a no-op ⇒ existing send/egress/approval behavior is
byte-for-byte unchanged. Verified: the pre-existing `external-send-egress` + `runtime-factory` + the full
suite stay green.
