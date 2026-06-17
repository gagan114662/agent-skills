/**
 * Pure console model (board + standup redesign). Turns the real platform seams — live agent sessions
 * (#147 mission control), the #13 approval queue (pending + executed), the workspace channels, and the
 * member directory — into the two groupings the console renders: the kanban board (by status) and the
 * standup (by project). A "project" is a department channel (#138 seeds one channel per marketing
 * function); a session belongs to its channel, an approval to its requesting agent's department channel.
 *
 * One status grammar, derived here so the chrome never re-invents it:
 *   running  → a session in motion           (braille spinner)
 *   waiting  → a pending approval, your call  (vermilion dot)
 *   shipped  → an executed approval           (green dot)
 *
 * Copy-free on purpose: this builds structure + hues only, so the components own the brand voice and the
 * model stays deterministically unit-testable (no store, no network, no clock).
 */
import type { ApprovalRequestDto } from "@reload/shared";
import type { Channel, LiveSessionDto } from "../../api/types.js";
import { agentColor, departmentColor, AGENT_DEPARTMENT, CONSOLE } from "../../brand.js";
import {
  DELIVERABLE_ACTION,
  cleanDeliverableTitle,
  deliverablePreview,
  humanActionLabel,
  isInternalDeliverableTask,
} from "./deliverable.js";

// The braille status glyph is a brand-defined grammar; re-export it from brand so the one source of
// truth is `brand.ts` while callers (and tests) can keep importing the model.
export { BRAILLE_FRAMES, brailleFrame } from "../../brand.js";

/** The subset of a directory entry the model needs (matches the store's `DirectoryEntry`). */
export interface DirectoryEntry {
  readonly id: string;
  readonly kind: "human" | "agent";
  readonly displayName: string;
}

export type ItemKind = "running" | "waiting" | "shipped";

/** The standup's primary nav target. */
export type ConsoleNav = "board" | "reports" | "history";

/** One unit of work, rendered as a board card AND a standup session row (same item, two groupings). */
export interface ConsoleItem {
  /** Stable key (session id or request id). */
  readonly key: string;
  readonly kind: ItemKind;
  /** The agent that owns the work, by display name (e.g. "Scout"). */
  readonly agentLabel: string;
  /** Department hue (the 3px card edge), or undefined for a non-department item. */
  readonly hue: string | undefined;
  readonly channelId: string | null;
  readonly channelName: string | null;
  /** Card/row headline — a HUMAN title (never the raw agent prompt or a `Deliverable ready for review:` line). */
  readonly title: string;
  /** Sub-line (status, step) — a HUMAN action label for approvals, never a raw `x.y` type id (#302). */
  readonly meta: string;
  readonly elapsedMs?: number;
  readonly costCents?: number;
  readonly amount?: number | null;
  /** Present on `waiting` items — the #13 request id to approve/reject (the gate is never bypassed). */
  readonly requestId?: string;
  readonly actionType?: string;
  /** Deliverable preview — the first line of what the agent produced (#302). Present on deliverable cards. */
  readonly preview?: string;
  /** The plain "what happens if I approve" line shown on a deliverable awaiting review (#302). */
  readonly consequence?: string;
}

/** A standup project lane (a department channel) with its items and a per-status tally. */
export interface ConsoleProject {
  readonly id: string;
  readonly name: string;
  readonly hue: string | undefined;
  readonly items: readonly ConsoleItem[];
  readonly counts: { running: number; waiting: number; shipped: number };
  /** True when at least one item is waiting on the human — drives the row's "needs you" affordance. */
  readonly needsYou: boolean;
}

export interface ConsoleModel {
  readonly items: readonly ConsoleItem[];
  readonly projects: readonly ConsoleProject[];
  readonly columns: Record<ItemKind, readonly ConsoleItem[]>;
}

export interface BuildConsoleInput {
  readonly liveSessions: readonly LiveSessionDto[];
  readonly pending: readonly ApprovalRequestDto[];
  readonly shipped: readonly ApprovalRequestDto[];
  readonly channels: readonly Channel[];
  readonly directory: Readonly<Record<string, DirectoryEntry>>;
  /**
   * Whether the workspace is activated — it has ≥1 venture (#226). When true, every department channel
   * renders as a project lane even with no live work yet, so an activated console always shows its
   * departments (created-but-paused) rather than an empty board. When false (the genuine first run, no
   * venture), only channels that actually have work surface — so a fresh workspace stays quiet and the
   * console shows its first-run empty desk instead. Defaults to the prior "work-only" behaviour.
   */
  readonly activated?: boolean;
}

const UNASSIGNED = "__unassigned";

/** Display name for a member id, or a quiet fallback. */
function memberLabel(directory: Readonly<Record<string, DirectoryEntry>>, id: string): string {
  return directory[id]?.displayName ?? "an agent";
}

/** First handle word of a display name, lowercased ("Scout" → "scout"). */
function handleOf(displayName: string): string {
  return displayName.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

/** A public (non-DM, non-archived) channel by name. */
function channelByName(channels: readonly Channel[], name: string | undefined): Channel | undefined {
  if (!name) return undefined;
  return channels.find((c) => c.kind === "public" && !c.isArchived && c.name === name);
}

/** The department channel an agent posts in, resolved from its name → department key → channel. */
function departmentChannel(
  channels: readonly Channel[],
  agentLabel: string,
): Channel | undefined {
  const dept = AGENT_DEPARTMENT[handleOf(agentLabel)];
  return dept ? channelByName(channels, dept) : undefined;
}

/** Cents → `$x.xx`. */
export function fmtCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Elapsed ms → a compact `1h 4m` / `4m 12s`. */
export function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m ${s % 60}s`;
}

export interface SpendForecast {
  /** 0–1 gauge fill. */
  readonly fraction: number;
  /** At-risk when over budget or pacing past 80% of the cap. */
  readonly atRisk: boolean;
  /** Whether a positive cap is set at all (no cap → no forecast claim). */
  readonly hasCap: boolean;
}

/** Derive the header spend gauge from the #104 budget block. Copy lives in the component. */
export function spendForecast(budget: {
  estimatedCostCents: number;
  budgetCents: number;
  overBudget: boolean;
  utilization: number | null;
}): SpendForecast {
  const hasCap = budget.budgetCents > 0;
  const u = budget.utilization ?? 0;
  const fraction = hasCap ? Math.max(0, Math.min(1, u)) : 0;
  const atRisk = hasCap && (budget.overBudget || u >= 0.8);
  return { fraction, atRisk, hasCap };
}

function runningItem(
  s: LiveSessionDto,
  channels: readonly Channel[],
  directory: Readonly<Record<string, DirectoryEntry>>,
): ConsoleItem {
  const agentLabel = memberLabel(directory, s.agentMemberId);
  const channel = channels.find((c) => c.id === s.channelId);
  const channelName = channel?.name ?? null;
  return {
    key: s.id,
    kind: "running",
    agentLabel,
    hue: departmentColor(channelName) ?? agentColor(agentLabel),
    channelId: s.channelId,
    channelName,
    title: channelName ? `${agentLabel} · #${channelName}` : agentLabel,
    meta: s.status,
    elapsedMs: s.elapsedMs,
    costCents: s.estimatedCostCents,
  };
}

/** The agent's original task prompt off a deliverable payload, if present (#248 stores it as `task`). */
function deliverableTask(r: ApprovalRequestDto): string {
  const task = r.payload?.task;
  return typeof task === "string" ? task : "";
}

function approvalItem(
  r: ApprovalRequestDto,
  kind: "waiting" | "shipped",
  channels: readonly Channel[],
  directory: Readonly<Record<string, DirectoryEntry>>,
): ConsoleItem {
  const agentLabel = memberLabel(directory, r.requesterMemberId);
  const channel = departmentChannel(channels, agentLabel);

  // #302: a completed-session deliverable card. The server summary is "Deliverable ready for review: <raw
  // prompt>" and the action type id is `agent.deliverable` — both leak internals. Re-derive a human title
  // (the work itself, distinct per item so the sidebar isn't a wall of "Deliverable rea…"), a preview of
  // what the agent produced, the consequence line, and a human action label. The raw type id never shows.
  if (r.actionType === DELIVERABLE_ACTION) {
    const draft = typeof r.payload?.draft === "string" ? r.payload.draft : "";
    const title = cleanDeliverableTitle(deliverableTask(r)) || CONSOLE.deliverable.untitled;
    // The preview is the agent's actual work product (extracted from the transcript). When it's empty the
    // session completed without producing anything reviewable (only explored/narrated): show a clear "no
    // deliverable yet" state — never process noise as a preview, and never a misleading "approve this draft".
    const preview = deliverablePreview(draft);
    const hasWork = preview.length > 0;
    return {
      key: r.id,
      kind,
      agentLabel,
      hue: agentColor(agentLabel),
      channelId: channel?.id ?? null,
      channelName: channel?.name ?? null,
      title,
      meta:
        kind === "shipped"
          ? CONSOLE.deliverable.shipped
          : hasWork
            ? CONSOLE.deliverable.review
            : CONSOLE.deliverable.noDeliverable,
      amount: r.amount,
      requestId: r.id,
      actionType: r.actionType,
      preview: hasWork ? preview : undefined,
      // Only promise "approve to accept this draft" when there IS a draft to accept.
      consequence: kind === "waiting" && hasWork ? CONSOLE.deliverable.consequence : undefined,
    };
  }

  return {
    key: r.id,
    kind,
    agentLabel,
    hue: agentColor(agentLabel),
    channelId: channel?.id ?? null,
    channelName: channel?.name ?? null,
    title: r.summary,
    // Humanise the action so a raw `x.y` type id never renders (#302), even for money actions.
    meta: humanActionLabel(r.actionType),
    amount: r.amount,
    requestId: r.id,
    actionType: r.actionType,
  };
}

/** Drop internal/test/dogfood deliverables (#302) so a real customer workspace never sees a QA probe. */
function visibleApproval(r: ApprovalRequestDto): boolean {
  if (r.actionType !== DELIVERABLE_ACTION) return true;
  return !isInternalDeliverableTask(deliverableTask(r) || r.summary);
}

/** Build the full console model (board columns + standup projects) from the live seams. */
export function buildConsole(input: BuildConsoleInput): ConsoleModel {
  const { liveSessions, pending, shipped, channels, directory, activated = false } = input;

  const items: ConsoleItem[] = [
    ...liveSessions.map((s) => runningItem(s, channels, directory)),
    ...pending.filter(visibleApproval).map((r) => approvalItem(r, "waiting", channels, directory)),
    ...shipped.filter(visibleApproval).map((r) => approvalItem(r, "shipped", channels, directory)),
  ];

  const columns: Record<ItemKind, ConsoleItem[]> = { running: [], waiting: [], shipped: [] };
  for (const it of items) columns[it.kind].push(it);

  const publicChannels = channels.filter((c) => c.kind === "public" && !c.isArchived);
  const publicIds = new Set(publicChannels.map((c) => c.id));

  // Group into projects, preserving channel order. An item on no channel — or on a channel that isn't a
  // public department lane (a DM, an archived room, or one we don't know) — falls into the trailing
  // "other" lane rather than being silently dropped, so nothing is ever lost from the board's totals.
  const byProject = new Map<string, ConsoleItem[]>();
  // When activated (#226), every department channel renders as a lane even with no work yet — so an
  // activated console shows its departments (the venture, created-but-paused) instead of an empty board.
  // Department channels are the spectrum-coloured ones; shared rooms (#general/#launch) stay quiet until
  // they have work, exactly as before.
  if (activated) {
    for (const c of publicChannels) {
      if (departmentColor(c.name)) byProject.set(c.id, []);
    }
  }
  for (const it of items) {
    const id = it.channelId && publicIds.has(it.channelId) ? it.channelId : UNASSIGNED;
    const list = byProject.get(id) ?? [];
    list.push(it);
    byProject.set(id, list);
  }

  const order = [...publicChannels.map((c) => c.id), UNASSIGNED];

  const projects: ConsoleProject[] = order
    .filter((id) => byProject.has(id))
    .map((id) => {
      const list = byProject.get(id)!;
      const channel = publicChannels.find((c) => c.id === id);
      const name = channel?.name ?? "other";
      const counts = {
        running: list.filter((i) => i.kind === "running").length,
        waiting: list.filter((i) => i.kind === "waiting").length,
        shipped: list.filter((i) => i.kind === "shipped").length,
      };
      return {
        id,
        name,
        hue: channel ? departmentColor(channel.name) : undefined,
        items: list,
        counts,
        needsYou: counts.waiting > 0,
      };
    });

  return { items, projects, columns };
}
