import { and, desc, eq } from "drizzle-orm";
import { db } from "../index.js";
import { dnsReceipts } from "../schema/index.js";
import type { DnsReceiptResult } from "../../onboarding/dns/provider.js";

/**
 * DNS receipts repository (#192, ADR-0192). Workspace-scoped, append-only (immutable receipts of the
 * records the agent configured + verified). Each provider configure/verify result is recorded as a row so
 * the owner has durable proof of exactly what the fleet did to their domain (acceptance 3).
 */

export interface DnsReceiptRow {
  id: string;
  domain: string;
  recordType: string;
  name: string;
  value: string;
  purpose: string;
  status: string;
  provider: string;
  createdAtMs: number;
}

/** Append a batch of provider receipts for a domain. Immutable — never updated. */
export async function recordDnsReceipts(input: {
  workspaceId: string;
  domain: string;
  provider: string;
  receipts: DnsReceiptResult[];
}): Promise<void> {
  if (input.receipts.length === 0) return;
  await db.insert(dnsReceipts).values(
    input.receipts.map((r) => ({
      workspaceId: input.workspaceId,
      domain: input.domain,
      recordType: r.recordType,
      name: r.name,
      value: r.value,
      purpose: r.purpose,
      status: r.status,
      provider: input.provider,
      detail: r.detail ?? {},
    })),
  );
}

/** List a workspace's DNS receipts, newest first; optionally scoped to one domain (read-only). */
export async function listDnsReceipts(
  workspaceId: string,
  domain?: string,
): Promise<DnsReceiptRow[]> {
  const where = domain
    ? and(eq(dnsReceipts.workspaceId, workspaceId), eq(dnsReceipts.domain, domain))
    : eq(dnsReceipts.workspaceId, workspaceId);
  const rows = await db
    .select()
    .from(dnsReceipts)
    .where(where)
    .orderBy(desc(dnsReceipts.createdAt));
  return rows.map((r) => ({
    id: r.id,
    domain: r.domain,
    recordType: r.recordType,
    name: r.name,
    value: r.value,
    purpose: r.purpose,
    status: r.status,
    provider: r.provider,
    createdAtMs: r.createdAt.getTime(),
  }));
}
