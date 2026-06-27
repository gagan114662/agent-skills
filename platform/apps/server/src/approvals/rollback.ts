export type RollbackMode = "provider_link" | "provider_manual" | "manual" | "recorded_only" | "unknown";

export interface ApprovalRollbackMetadata {
  mode: RollbackMode;
  reversible: boolean;
  label: string;
  status: string;
  url: string | null;
  provider: string | null;
  externalId: string | null;
}

function readString(result: Record<string, unknown>, key: string): string | null {
  const value = result[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isMoneyAction(actionType: string): boolean {
  return /billing|refund|charge|payout|wallet|disburse|spend|payment/.test(actionType);
}

function isOutboundMutation(actionType: string): boolean {
  return /send|publish|deploy|external|outreach|social|email|browser|connect/.test(actionType);
}

function existingRollback(result: Record<string, unknown>): ApprovalRollbackMetadata | null {
  const raw = result.rollback;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rollback = raw as Record<string, unknown>;
  const mode = readString(rollback, "mode") ?? "unknown";
  const label = readString(rollback, "label") ?? "Rollback status";
  const status = readString(rollback, "status") ?? label;
  return {
    mode: mode as RollbackMode,
    reversible: rollback.reversible === true,
    label,
    status,
    url: readString(rollback, "url"),
    provider: readString(rollback, "provider"),
    externalId: readString(rollback, "externalId"),
  };
}

export function attachApprovalRollbackMetadata(
  actionType: string,
  result: Record<string, unknown>,
): Record<string, unknown> {
  if (existingRollback(result)) return { ...result, rollback: existingRollback(result) };

  const url = readString(result, "rollbackUrl") ?? readString(result, "undoUrl") ?? readString(result, "revertUrl");
  const provider = readString(result, "provider");
  const externalId = readString(result, "externalId") ?? readString(result, "messageId") ?? readString(result, "deploymentId");
  const executed = result.executed === true || result.sent === true || result.status === "published";

  if (url) {
    return {
      ...result,
      rollback: {
        mode: "provider_link",
        reversible: true,
        label: "Provider rollback",
        status: "Reversible through the linked provider undo/rollback action.",
        url,
        provider,
        externalId,
      } satisfies ApprovalRollbackMetadata,
    };
  }

  if (isMoneyAction(actionType)) {
    return {
      ...result,
      rollback: {
        mode: "manual",
        reversible: false,
        label: "Manual money control",
        status: "Money movement is not assumed reversible; approval is the rollback boundary.",
        url: null,
        provider,
        externalId,
      } satisfies ApprovalRollbackMetadata,
    };
  }

  if (result.recorded === true && result.executed === false) {
    return {
      ...result,
      rollback: {
        mode: "recorded_only",
        reversible: false,
        label: "Recorded only",
        status: "No external side effect ran from this approval; there is nothing to roll back.",
        url: null,
        provider,
        externalId,
      } satisfies ApprovalRollbackMetadata,
    };
  }

  if (executed && provider) {
    return {
      ...result,
      rollback: {
        mode: "provider_manual",
        reversible: false,
        label: "Provider receipt",
        status: "Executed with a provider receipt; undo depends on the provider and no rollback link was returned.",
        url: null,
        provider,
        externalId,
      } satisfies ApprovalRollbackMetadata,
    };
  }

  return {
    ...result,
    rollback: {
      mode: isOutboundMutation(actionType) ? "provider_manual" : "unknown",
      reversible: false,
      label: isOutboundMutation(actionType) ? "Provider rollback unknown" : "Rollback status unknown",
      status: isOutboundMutation(actionType)
        ? "No provider rollback link was returned; use the audit receipt before taking manual action."
        : "No rollback metadata was returned by this executor.",
      url: null,
      provider,
      externalId,
    } satisfies ApprovalRollbackMetadata,
  };
}
