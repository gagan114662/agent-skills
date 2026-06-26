import type { FirstRunReceiptInput } from "../../api/types.js";
import type { SiteFinding, TeamMission } from "./provider.js";

export const FIRST_RUN_RECEIPT_KEY = "ipop:first-run-receipt:v1";

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function firstRunReceiptInput(
  input: string,
  finding: SiteFinding,
  mission: TeamMission,
): FirstRunReceiptInput {
  const artifact = mission.artifacts[0] ?? {
    title: "site-read receipt",
    summary: finding.finding,
  };
  return {
    stage: "agent_result",
    target: mission.target || finding.host || input.trim(),
    finding: finding.finding,
    artifactTitle: artifact.title,
    artifactSummary: artifact.summary,
    receipt: mission.receipts[mission.receipts.length - 1] ?? "team mission recorded",
  };
}

export function savePendingFirstRunReceipt(
  input: string,
  finding: SiteFinding,
  mission: TeamMission,
): void {
  const store = storage();
  if (!store) return;
  store.setItem(
    FIRST_RUN_RECEIPT_KEY,
    JSON.stringify(firstRunReceiptInput(input, finding, mission)),
  );
}

export function readPendingFirstRunReceipt(): FirstRunReceiptInput | null {
  const store = storage();
  const raw = store?.getItem(FIRST_RUN_RECEIPT_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as FirstRunReceiptInput;
    if (
      typeof parsed.target === "string" &&
      typeof parsed.finding === "string" &&
      typeof parsed.artifactTitle === "string" &&
      typeof parsed.artifactSummary === "string" &&
      typeof parsed.receipt === "string"
    ) {
      return parsed;
    }
  } catch {
    // Ignore malformed browser state; the server still validates before persistence.
  }
  return null;
}

export function clearPendingFirstRunReceipt(): void {
  storage()?.removeItem(FIRST_RUN_RECEIPT_KEY);
}
