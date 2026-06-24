export interface ApprovalExpiryView {
  expiresAt: string | null;
  expiresAtTimezone: string;
  expiresAtLabel: string | null;
}

export function normalizeTimeZone(value: string | null | undefined): string {
  const zone = value?.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date(0));
    return zone;
  } catch {
    return "UTC";
  }
}

export function formatApprovalExpiry(
  expiresAt: Date | null,
  timezone: string | null | undefined,
): ApprovalExpiryView {
  const expiresAtTimezone = normalizeTimeZone(timezone);
  if (!expiresAt) {
    return { expiresAt: null, expiresAtTimezone, expiresAtLabel: null };
  }
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: expiresAtTimezone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "shortOffset",
  }).format(expiresAt);
  return {
    expiresAt: expiresAt.toISOString(),
    expiresAtTimezone,
    expiresAtLabel: `${label} (${expiresAtTimezone})`,
  };
}

