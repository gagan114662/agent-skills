import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  unique,
  check,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { newId } from "../id.js";
import { workspaces } from "./workspaces.js";
import { members } from "./identities.js";

/**
 * External account onboarding (#192, ADR-0192): human-once setup, agent-forever operation.
 *
 * Three workspace-scoped tables. None hold authority over an existing business-domain table — they
 * record the setup handoff, the write-only credential vault, and DNS receipts. The owner creates the
 * account + pastes keys ONCE; the fleet then operates through the vault (the keys are SEALED and never
 * read back by any API — only injected into a runtime as env, redacted by the SessionManager).
 */

export const SERVICE_KINDS = [
  "esp",
  "sms",
  "ad_account",
  "analytics",
  "registrar",
  "hosting",
  "payment",
  "other",
] as const;

export const SETUP_REVERSIBILITY_CLASSES = ["reversible", "cheap", "irreversible"] as const;
export const SETUP_REQUEST_STATUSES = ["requested", "connected", "dismissed"] as const;
export const EXTERNAL_CREDENTIAL_STATUSES = ["connected", "revoked"] as const;
export const EXTERNAL_CREDENTIAL_AUDIT_ACTIONS = ["connected", "revoked"] as const;
export const DNS_RECEIPT_PURPOSES = ["dns", "ssl", "spf", "dkim", "dmarc", "verification"] as const;
export const DNS_RECEIPT_STATUSES = ["configured", "verified", "failed"] as const;

/**
 * The SETUP request the fleet files when a venture needs an external service (#192 acceptance 1). It
 * carries exactly: which service, which plan, which scopes, why, and the projected cost. The optional
 * `approvalRequestId` links the #13 pending approval that parks it in the decision queue so blocked work
 * ages visibly (acceptance 5). `unique(workspace_id, service_key)` ⇒ re-filing upserts, never stacks.
 */
export const externalSetupRequests = pgTable(
  "external_setup_requests",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    serviceKey: text("service_key").notNull(),
    serviceKind: text("service_kind", { enum: SERVICE_KINDS }).notNull(),
    displayName: text("display_name").notNull(),
    plan: text("plan"),
    scopes: jsonb("scopes")
      .notNull()
      .default(sql`'[]'::jsonb`),
    reason: text("reason").notNull(),
    projectedCostCents: integer("projected_cost_cents").notNull().default(0),
    reversibility: text("reversibility", { enum: SETUP_REVERSIBILITY_CLASSES }).notNull(),
    status: text("status", { enum: SETUP_REQUEST_STATUSES }).notNull().default("requested"),
    /** Soft link (no FK) to the #13 approval that parks this — the onboarding layer never owns approvals. */
    approvalRequestId: uuid("approval_request_id"),
    requestedByMemberId: uuid("requested_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueService: unique("external_setup_requests_service_uk").on(t.workspaceId, t.serviceKey),
    kindCk: check(
      "external_setup_requests_kind_ck",
      sql`${t.serviceKind} IN ('esp','sms','ad_account','analytics','registrar','hosting','payment','other')`,
    ),
    reversibilityCk: check(
      "external_setup_requests_reversibility_ck",
      sql`${t.reversibility} IN ('reversible','cheap','irreversible')`,
    ),
    statusCk: check(
      "external_setup_requests_status_ck",
      sql`${t.status} IN ('requested','connected','dismissed')`,
    ),
  }),
);

/**
 * The per-tenant WRITE-ONLY vault for arbitrary external services (#192 acceptance 2/4), mirroring #68
 * `workspace_agent_credentials`. One row per (workspace, service) — what makes pooling impossible.
 * `secrets` maps env-var-name → SEALED value (crypto/secretbox; transparent pass-through when no key);
 * `envKeys` is the NON-secret list of names so the resolver/UI can act without decrypting. `fingerprint`
 * is non-reversible (connected-state UI only). `status` flips to `revoked` on disconnect so dependent
 * capabilities go offline gracefully while the audit trail (connected_by/at) survives.
 */
export const externalCredentials = pgTable(
  "external_credentials",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    serviceKey: text("service_key").notNull(),
    /** { ENV_VAR: 'enc:...'|'raw:...' } — values SEALED; NEVER returned by any API. */
    secrets: jsonb("secrets")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Non-secret list of env var names present (so the resolver injects without decrypting status). */
    envKeys: jsonb("env_keys")
      .notNull()
      .default(sql`'[]'::jsonb`),
    fingerprint: text("fingerprint").notNull(),
    scopes: jsonb("scopes")
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: text("status", { enum: EXTERNAL_CREDENTIAL_STATUSES }).notNull().default("connected"),
    rotationReminderDays: integer("rotation_reminder_days").notNull().default(0),
    connectedByMemberId: uuid("connected_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.workspaceId, t.serviceKey] }),
    statusCk: check("external_credentials_status_ck", sql`${t.status} IN ('connected','revoked')`),
  }),
);

/**
 * Append-only credential lifecycle audit (#928). Unlike `external_credentials`, this never overwrites on
 * reconnect: every connect/revoke transition keeps the actor, timestamp, service, scopes, and non-secret
 * fingerprint so compliance and incident response can answer what was held when.
 */
export const externalCredentialAuditEvents = pgTable(
  "external_credential_audit_events",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    serviceKey: text("service_key").notNull(),
    action: text("action", { enum: EXTERNAL_CREDENTIAL_AUDIT_ACTIONS }).notNull(),
    actorMemberId: uuid("actor_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    fingerprint: text("fingerprint"),
    envKeys: jsonb("env_keys")
      .notNull()
      .default(sql`'[]'::jsonb`),
    scopes: jsonb("scopes")
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index("external_credential_audit_events_workspace_idx").on(
      t.workspaceId,
      t.createdAt,
    ),
    byService: index("external_credential_audit_events_service_idx").on(t.serviceKey, t.createdAt),
    actionCk: check(
      "external_credential_audit_events_action_ck",
      sql`${t.action} IN ('connected','revoked')`,
    ),
  }),
);

/**
 * Immutable DNS/SSL/email-auth receipts (#192 acceptance 3). After the owner buys the domain (the money
 * step), the agent configures + verifies records autonomously and writes one receipt per record. These
 * are PUBLIC DNS records (SPF/DKIM/DMARC are published openly), so values are plaintext.
 */
export const dnsReceipts = pgTable(
  "dns_receipts",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    recordType: text("record_type").notNull(),
    name: text("name").notNull(),
    value: text("value").notNull(),
    purpose: text("purpose", { enum: DNS_RECEIPT_PURPOSES }).notNull(),
    status: text("status", { enum: DNS_RECEIPT_STATUSES }).notNull(),
    provider: text("provider").notNull(),
    detail: jsonb("detail")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    purposeCk: check(
      "dns_receipts_purpose_ck",
      sql`${t.purpose} IN ('dns','ssl','spf','dkim','dmarc','verification')`,
    ),
    statusCk: check(
      "dns_receipts_status_ck",
      sql`${t.status} IN ('configured','verified','failed')`,
    ),
  }),
);
