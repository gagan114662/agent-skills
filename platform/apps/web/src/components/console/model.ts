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
import { agentColor, departmentColor, AGENT_DEPARTMENT } from "../../brand.js";

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
  /** Card/row headline. */
  readonly title: string;
  /** Sub-line (status, step, action type). */
  readonly meta: string;
  readonly elapsedMs?: number;
  readonly costCents?: number;
  readonly amount?: number | null;
  /** Present on `waiting` items — the #13 request id to approve/reject (the gate is never bypassed). */
  readonly requestId?: string;
  readonly actionType?: string;
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

/** The braille spinner frames (the one running-tell in the whole console). */
export const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** The frame for a given tick (wraps). Pure so the spinner stays testable. */
export function brailleFrame(tick: number): string {
  const n = BRAILLE_FRAMES.length;
  return BRAILLE_FRAMES[((tick % n) + n) % n]!;
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

function approvalItem(
  r: ApprovalRequestDto,
  kind: "waiting" | "shipped",
  channels: readonly Channel[],
  directory: Readonly<Record<string, DirectoryEntry>>,
): ConsoleItem {
  const agentLabel = memberLabel(directory, r.requesterMemberId);
  const channel = departmentChannel(channels, agentLabel);
  return {
    key: r.id,
    kind,
    agentLabel,
    hue: agentColor(agentLabel),
    channelId: channel?.id ?? null,
    channelName: channel?.name ?? null,
    title: r.summary,
    meta: r.actionType,
    amount: r.amount,
    requestId: r.id,
    actionType: r.actionType,
  };
}

/** Build the full console model (board columns + standup projects) from the live seams. */
export function buildConsole(input: BuildConsoleInput): ConsoleModel {
  const { liveSessions, pending, shipped, channels, directory } = input;

  const items: ConsoleItem[] = [
    ...liveSessions.map((s) => runningItem(s, channels, directory)),
    ...pending.map((r) => approvalItem(r, "waiting", channels, directory)),
    ...shipped.map((r) => approvalItem(r, "shipped", channels, directory)),
  ];

  const columns: Record<ItemKind, ConsoleItem[]> = { running: [], waiting: [], shipped: [] };
  for (const it of items) columns[it.kind].push(it);

  // Group into projects, preserving channel order; unassigned items fall into a trailing lane.
  const byProject = new Map<string, ConsoleItem[]>();
  for (const it of items) {
    const id = it.channelId ?? UNASSIGNED;
    const list = byProject.get(id) ?? [];
    list.push(it);
    byProject.set(id, list);
  }

  const publicChannels = channels.filter((c) => c.kind === "public" && !c.isArchived);
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
