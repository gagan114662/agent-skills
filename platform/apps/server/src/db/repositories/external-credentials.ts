import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.js";
import { externalCredentialAuditEvents, externalCredentials } from "../schema/index.js";
import { seal, open, tokenFingerprint, loadEncKey } from "../../crypto/secretbox.js";

/**
 * Per-tenant WRITE-ONLY vault for arbitrary external services (#192, ADR-0192), mirroring the #68
 * subscription vault (`db/repositories/agent-credentials.ts`). One row per (workspace, service). Each
 * secret value is stored SEALED (AES-256-GCM via `crypto/secretbox` when `AGENT_CREDENTIALS_ENC_KEY` is
 * set; transparent pass-through otherwise) + a non-reversible fingerprint. Secrets are read back ONLY by
 * `resolveServiceSecrets` to be injected into a runtime — `getServiceStatus`/`listServiceStatuses`
 * deliberately never select the `secrets` column, so no status API can leak a key. Reads are keyed by
 * `workspaceId`, so a credential is strictly scoped to its own tenant (the never-pool invariant).
 */

/** What the Settings/console UI is allowed to know about a service — never the secret values. */
export interface ServiceCredentialRow {
  serviceKey: string;
  /** True only when the row has live provider proof material; consent-only rows are not connected. */
  connected: boolean;
  status: "connected" | "revoked";
  fingerprint: string;
  envKeys: string[];
  scopes: string[];
  rotationReminderDays: number;
  connectedAtMs: number;
  revokedAtMs: number | null;
}

export interface CredentialAuditEventRow {
  id: string;
  workspaceId: string;
  serviceKey: string;
  action: "connected" | "revoked";
  actorMemberId: string | null;
  fingerprint: string | null;
  envKeys: string[];
  scopes: string[];
  createdAt: Date;
}

/** Connect (or re-connect) a service's credentials. The secret values are sealed; last write wins. */
export async function setServiceCredentials(input: {
  workspaceId: string;
  serviceKey: string;
  /** Plain env-var → value map the owner pasted (e.g. { SENDGRID_API_KEY: "SG.xxx" }). */
  secrets: Record<string, string>;
  scopes?: string[];
  rotationReminderDays?: number;
  connectedByMemberId?: string | null;
}): Promise<ServiceCredentialRow> {
  const key = loadEncKey();
  const sealed: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.secrets)) {
    sealed[name] = seal(value, key);
  }
  const envKeys = Object.keys(input.secrets);
  // Fingerprint over the concatenated material — stable proof of "connected" without exposing values.
  const fingerprint = tokenFingerprint(
    envKeys
      .sort()
      .map((k) => `${k}=${input.secrets[k]}`)
      .join("\n"),
  );
  const scopes = input.scopes ?? [];
  const rotationReminderDays = input.rotationReminderDays ?? 0;
  const now = new Date();
  await db
    .insert(externalCredentials)
    .values({
      workspaceId: input.workspaceId,
      serviceKey: input.serviceKey,
      secrets: sealed,
      envKeys,
      fingerprint,
      scopes,
      status: "connected",
      rotationReminderDays,
      connectedByMemberId: input.connectedByMemberId ?? null,
      connectedAt: now,
      updatedAt: now,
      revokedAt: null,
    })
    .onConflictDoUpdate({
      target: [externalCredentials.workspaceId, externalCredentials.serviceKey],
      set: {
        secrets: sealed,
        envKeys,
        fingerprint,
        scopes,
        status: "connected",
        rotationReminderDays,
        connectedByMemberId: input.connectedByMemberId ?? null,
        connectedAt: now,
        updatedAt: now,
        revokedAt: null,
      },
    });
  await appendCredentialAuditEvent({
    workspaceId: input.workspaceId,
    serviceKey: input.serviceKey,
    action: "connected",
    actorMemberId: input.connectedByMemberId ?? null,
    fingerprint,
    envKeys,
    scopes,
    createdAt: now,
  });
  const connected = envKeys.length > 0;
  return {
    serviceKey: input.serviceKey,
    connected,
    status: "connected",
    fingerprint,
    envKeys,
    scopes,
    rotationReminderDays,
    connectedAtMs: now.getTime(),
    revokedAtMs: null,
  };
}

/**
 * Resolve a service's secrets (decrypted) for injection into a runtime — the ONLY read-back path. Returns
 * `{}` when the service is not connected or has been revoked, so a revoked credential goes offline
 * gracefully (the dependent capability gets no env). Never call this from a route that returns to a user.
 */
export async function resolveServiceSecrets(
  workspaceId: string,
  serviceKey: string,
): Promise<Record<string, string>> {
  const [row] = await db
    .select({ secrets: externalCredentials.secrets, status: externalCredentials.status })
    .from(externalCredentials)
    .where(
      and(
        eq(externalCredentials.workspaceId, workspaceId),
        eq(externalCredentials.serviceKey, serviceKey),
      ),
    )
    .limit(1);
  if (!row || row.status !== "connected") return {};
  const key = loadEncKey();
  const out: Record<string, string> = {};
  for (const [name, sealedValue] of Object.entries(row.secrets as Record<string, string>)) {
    out[name] = open(sealedValue, key);
  }
  return out;
}

/**
 * Resolve every connected service's secrets for a workspace, merged into one env map (the runtime
 * injection surface). Revoked rows are skipped. Used only by the {@link ExternalSecretsResolver}.
 */
export async function resolveAllServiceSecrets(
  workspaceId: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select({ secrets: externalCredentials.secrets, status: externalCredentials.status })
    .from(externalCredentials)
    .where(eq(externalCredentials.workspaceId, workspaceId));
  const key = loadEncKey();
  const out: Record<string, string> = {};
  for (const row of rows) {
    if (row.status !== "connected") continue;
    for (const [name, sealedValue] of Object.entries(row.secrets as Record<string, string>)) {
      out[name] = open(sealedValue, key);
    }
  }
  return out;
}

/** The connected/revoked state for a single service — never exposes the secrets. */
export async function getServiceStatus(
  workspaceId: string,
  serviceKey: string,
): Promise<ServiceCredentialRow | null> {
  const [row] = await db
    .select({
      serviceKey: externalCredentials.serviceKey,
      status: externalCredentials.status,
      fingerprint: externalCredentials.fingerprint,
      envKeys: externalCredentials.envKeys,
      scopes: externalCredentials.scopes,
      rotationReminderDays: externalCredentials.rotationReminderDays,
      connectedAt: externalCredentials.connectedAt,
      revokedAt: externalCredentials.revokedAt,
    })
    .from(externalCredentials)
    .where(
      and(
        eq(externalCredentials.workspaceId, workspaceId),
        eq(externalCredentials.serviceKey, serviceKey),
      ),
    )
    .limit(1);
  if (!row) return null;
  return mapStatusRow(row);
}

/** Every service credential's state for a workspace — never exposes secrets. */
export async function listServiceStatuses(workspaceId: string): Promise<ServiceCredentialRow[]> {
  const rows = await db
    .select({
      serviceKey: externalCredentials.serviceKey,
      status: externalCredentials.status,
      fingerprint: externalCredentials.fingerprint,
      envKeys: externalCredentials.envKeys,
      scopes: externalCredentials.scopes,
      rotationReminderDays: externalCredentials.rotationReminderDays,
      connectedAt: externalCredentials.connectedAt,
      revokedAt: externalCredentials.revokedAt,
    })
    .from(externalCredentials)
    .where(eq(externalCredentials.workspaceId, workspaceId));
  return rows.map(mapStatusRow);
}

/**
 * Revoke a service (idempotent). Marks the row `revoked` rather than deleting it, so the audit trail
 * survives and `resolveServiceSecrets` returns `{}` — dependent capabilities go offline gracefully.
 */
export async function revokeServiceCredentials(
  workspaceId: string,
  serviceKey: string,
  actorMemberId?: string | null,
): Promise<void> {
  const now = new Date();
  const before = await getServiceStatus(workspaceId, serviceKey);
  await db
    .update(externalCredentials)
    .set({ status: "revoked", secrets: {}, updatedAt: now, revokedAt: now })
    .where(
      and(
        eq(externalCredentials.workspaceId, workspaceId),
        eq(externalCredentials.serviceKey, serviceKey),
      ),
    );
  await appendCredentialAuditEvent({
    workspaceId,
    serviceKey,
    action: "revoked",
    actorMemberId: actorMemberId ?? null,
    fingerprint: before?.fingerprint ?? null,
    envKeys: before?.envKeys ?? [],
    scopes: before?.scopes ?? [],
    createdAt: now,
  });
}

/** Append a non-secret, immutable credential lifecycle audit event (#928). */
export async function appendCredentialAuditEvent(input: {
  workspaceId: string;
  serviceKey: string;
  action: "connected" | "revoked";
  actorMemberId?: string | null;
  fingerprint?: string | null;
  envKeys?: string[];
  scopes?: string[];
  createdAt?: Date;
}): Promise<CredentialAuditEventRow> {
  const now = input.createdAt ?? new Date();
  const [row] = await db
    .insert(externalCredentialAuditEvents)
    .values({
      workspaceId: input.workspaceId,
      serviceKey: input.serviceKey,
      action: input.action,
      actorMemberId: input.actorMemberId ?? null,
      fingerprint: input.fingerprint ?? null,
      envKeys: input.envKeys ?? [],
      scopes: input.scopes ?? [],
      createdAt: now,
    })
    .returning({
      id: externalCredentialAuditEvents.id,
      workspaceId: externalCredentialAuditEvents.workspaceId,
      serviceKey: externalCredentialAuditEvents.serviceKey,
      action: externalCredentialAuditEvents.action,
      actorMemberId: externalCredentialAuditEvents.actorMemberId,
      fingerprint: externalCredentialAuditEvents.fingerprint,
      envKeys: externalCredentialAuditEvents.envKeys,
      scopes: externalCredentialAuditEvents.scopes,
      createdAt: externalCredentialAuditEvents.createdAt,
    });
  return mapAuditEventRow(row!);
}

/** Tenant-scoped credential lifecycle history, newest first (#928). */
export async function listCredentialAuditEvents(
  workspaceId: string,
): Promise<CredentialAuditEventRow[]> {
  const rows = await db
    .select({
      id: externalCredentialAuditEvents.id,
      workspaceId: externalCredentialAuditEvents.workspaceId,
      serviceKey: externalCredentialAuditEvents.serviceKey,
      action: externalCredentialAuditEvents.action,
      actorMemberId: externalCredentialAuditEvents.actorMemberId,
      fingerprint: externalCredentialAuditEvents.fingerprint,
      envKeys: externalCredentialAuditEvents.envKeys,
      scopes: externalCredentialAuditEvents.scopes,
      createdAt: externalCredentialAuditEvents.createdAt,
    })
    .from(externalCredentialAuditEvents)
    .where(eq(externalCredentialAuditEvents.workspaceId, workspaceId))
    .orderBy(desc(externalCredentialAuditEvents.createdAt));
  return rows.map(mapAuditEventRow);
}

/** Cross-workspace service history for operator incident response (#928), newest first. */
export async function listCredentialAuditEventsForService(
  serviceKey: string,
): Promise<CredentialAuditEventRow[]> {
  const rows = await db
    .select({
      id: externalCredentialAuditEvents.id,
      workspaceId: externalCredentialAuditEvents.workspaceId,
      serviceKey: externalCredentialAuditEvents.serviceKey,
      action: externalCredentialAuditEvents.action,
      actorMemberId: externalCredentialAuditEvents.actorMemberId,
      fingerprint: externalCredentialAuditEvents.fingerprint,
      envKeys: externalCredentialAuditEvents.envKeys,
      scopes: externalCredentialAuditEvents.scopes,
      createdAt: externalCredentialAuditEvents.createdAt,
    })
    .from(externalCredentialAuditEvents)
    .where(eq(externalCredentialAuditEvents.serviceKey, serviceKey))
    .orderBy(desc(externalCredentialAuditEvents.createdAt));
  return rows.map(mapAuditEventRow);
}

function mapStatusRow(row: {
  serviceKey: string;
  status: string;
  fingerprint: string;
  envKeys: unknown;
  scopes: unknown;
  rotationReminderDays: number;
  connectedAt: Date;
  revokedAt: Date | null;
}): ServiceCredentialRow {
  const envKeys = (row.envKeys as string[]) ?? [];
  return {
    serviceKey: row.serviceKey,
    connected: row.status === "connected" && envKeys.length > 0,
    status: row.status as "connected" | "revoked",
    fingerprint: row.fingerprint,
    envKeys,
    scopes: (row.scopes as string[]) ?? [],
    rotationReminderDays: row.rotationReminderDays,
    connectedAtMs: row.connectedAt.getTime(),
    revokedAtMs: row.revokedAt ? row.revokedAt.getTime() : null,
  };
}

function mapAuditEventRow(row: {
  id: string;
  workspaceId: string;
  serviceKey: string;
  action: string;
  actorMemberId: string | null;
  fingerprint: string | null;
  envKeys: unknown;
  scopes: unknown;
  createdAt: Date;
}): CredentialAuditEventRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    serviceKey: row.serviceKey,
    action: row.action as "connected" | "revoked",
    actorMemberId: row.actorMemberId,
    fingerprint: row.fingerprint,
    envKeys: (row.envKeys as string[]) ?? [],
    scopes: (row.scopes as string[]) ?? [],
    createdAt: row.createdAt,
  };
}
