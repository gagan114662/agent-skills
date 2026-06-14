/**
 * The console — the product's one and only authed surface (console v5). The whole app is two panes:
 *
 *   · LEFT  (StandupPanel)  ← projects → sessions, the Conductor anatomy + account utilities
 *   · CENTER (this board)   ← one kanban: Work in progress / Approval needed / Done
 *   · DRAWER (PeekDrawer)   ← dive into any card or session row: steps, the "why?" audit, a composer to
 *                             steer, and (for approval-needed work) Approve / Not yet
 *
 * Every surface reads a real seam: live sessions from #147 mission control, pending/done from the #13
 * approvals queue, the spend gauge + fleet-health from the #104 founder console. Approvals decide through
 * `store.decideApprove` / `store.decideReject` — the real #13 gate, never a shortcut and never weakened.
 * Nothing is invented; the only copy comes from `brand.ts`; all motion is reduced-motion gated in leaves.
 *
 * There is no top nav (it superseded the #199 layout): the few off-board surfaces that must stay reachable
 * — the owner's Claude/Slack connection (#68/#170) and the trial → pricing funnel (#153) — open as
 * overlays from the left footer / the paywall nudge rather than a tab strip.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalRequestDto } from "@reload/shared";
import { useAppState, useStore } from "../../store/StoreContext.js";
import { authorLabel } from "../../store/store.js";
import { api } from "../../api/client.js";
import type { FounderConsoleDto, MissionControlDto } from "../../api/types.js";
import { BRAND, CONSOLE, agentColor, consoleWaitingChip } from "../../brand.js";
import { popConfettiFromEvent } from "../../lib/confetti.js";
import { ConnectClaudePanel } from "../ConnectClaudePanel.js";
import { SlackConnectPanel } from "../SlackConnectPanel.js";
import { PricingPanel } from "../PricingPanel.js";
import { SoftPaywall } from "../site/SoftPaywall.js";
import { StandupPanel } from "./StandupPanel.js";
import { Board } from "./Board.js";
import { ProjectSettingsSheet } from "./ProjectSettingsSheet.js";
import { PeekDrawer, type PeekAuditLine, type PeekTranscriptLine } from "./PeekDrawer.js";
import {
  buildConsole,
  fmtCents,
  spendForecast,
  type ConsoleItem,
  type ConsoleProject,
} from "./model.js";

interface PeekTarget {
  item: ConsoleItem;
  mode: "transcript" | "audit";
}

/** The receipts we actually hold for an item → the "why?" audit trail (nothing fabricated). */
function auditLines(item: ConsoleItem): PeekAuditLine[] {
  const lines: PeekAuditLine[] = [{ label: `Owner · ${item.agentLabel}`, tag: "agent" }];
  if (item.channelName) lines.push({ label: `Department · #${item.channelName}`, tag: "scope" });
  if (item.actionType) lines.push({ label: `Action · ${item.actionType} · held for your yes`, tag: "gate" });
  if (item.amount != null) lines.push({ label: `Amount · ${fmtCents(item.amount)}`, tag: "budget" });
  if (item.costCents !== undefined) lines.push({ label: `Spend so far · ${fmtCents(item.costCents)}`, tag: "budget" });
  lines.push({ label: `Status · ${item.meta}`, tag: item.kind });
  return lines;
}

/** The concrete "what you're approving" line shown above the Approve / Not yet pair (waiting items). */
function askLineOf(item: ConsoleItem): string {
  const action = item.actionType ?? item.meta;
  return item.amount != null ? `${action} · ${fmtCents(item.amount)}` : action;
}

export function ConsoleView(): React.JSX.Element {
  const { identity, channels, directory, messagesByChannel, paywall } = useAppState();
  const store = useStore();
  const workspaceId = identity?.workspaceId;

  const [mc, setMc] = useState<MissionControlDto | null>(null);
  const [fc, setFc] = useState<FounderConsoleDto | null>(null);
  const [pending, setPending] = useState<readonly ApprovalRequestDto[]>([]);
  const [shipped, setShipped] = useState<readonly ApprovalRequestDto[]>([]);

  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [openProjectIds, setOpenProjectIds] = useState<ReadonlySet<string>>(new Set());
  const [filterNeedsYou, setFilterNeedsYou] = useState(false);
  const [peek, setPeek] = useState<PeekTarget | null>(null);
  const [settingsProject, setSettingsProject] = useState<ConsoleProject | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [shellSettingsOpen, setShellSettingsOpen] = useState(false);
  const [pricingOpen, setPricingOpen] = useState(false);

  // Guards every async setState so a poll that resolves after unmount is a no-op (no leak / no warning).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // --- live seams (view-local, the #104/#147 polled pattern) ---------------------------------------
  async function refreshApprovals(): Promise<void> {
    if (!workspaceId) return;
    try {
      const [p, s] = await Promise.all([
        api.approvals.list(workspaceId, "pending"),
        api.approvals.list(workspaceId, "executed"),
      ]);
      if (!mounted.current) return;
      setPending(p);
      setShipped(s);
    } catch {
      /* transient; the board degrades to what's already shown */
    }
  }

  async function refreshFounder(): Promise<void> {
    if (!workspaceId) return;
    try {
      const next = await api.getFounderConsole(workspaceId);
      if (mounted.current) setFc(next);
    } catch {
      /* leave prior snapshot */
    }
  }

  // The spend snapshot AND the approvals queue refresh on the same 15s beat, so the board's "Approval
  // needed" lane never goes stale while the page sits open.
  useEffect(() => {
    if (!workspaceId) return;
    void refreshApprovals();
    void refreshFounder();
    const timer = window.setInterval(() => {
      void refreshApprovals();
      void refreshFounder();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    const tick = async (): Promise<void> => {
      try {
        const next = await api.missionControl.get(workspaceId);
        if (mounted.current) setMc(next);
      } catch {
        /* transient; next poll retries */
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 4000);
    return () => window.clearInterval(timer);
  }, [workspaceId]);

  const model = useMemo(
    () =>
      buildConsole({
        liveSessions: mc?.sessions ?? [],
        pending,
        shipped,
        channels,
        directory,
      }),
    [mc, pending, shipped, channels, directory],
  );

  // Default: open every lane and select the first project as the header context.
  useEffect(() => {
    if (model.projects.length === 0) return;
    setOpenProjectIds((prev) => (prev.size ? prev : new Set(model.projects.map((p) => p.id))));
    setActiveProjectId((prev) => prev ?? model.projects[0]!.id);
  }, [model.projects]);

  const pendingCount = pending.length;
  const forecast = fc ? spendForecast(fc.budget) : null;
  const activeProject = model.projects.find((p) => p.id === activeProjectId) ?? null;
  const headerTitle = activeProject ? `#${activeProject.name}` : BRAND.name;

  // --- intent handlers -----------------------------------------------------------------------------
  function toggleProject(id: string): void {
    setOpenProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Open the drawer on a task. `audit` opens straight to the "why?" receipts (the board's why link). */
  function dive(item: ConsoleItem, mode: "transcript" | "audit"): void {
    if (item.channelId) void store.selectChannel(item.channelId);
    setPeek({ item, mode });
  }

  function openFirstWaiting(): void {
    const first = model.columns.waiting[0];
    if (first) dive(first, "transcript");
  }

  function openSettings(project: ConsoleProject): void {
    setSettingsProject(project);
    setSettingsOpen(true);
  }

  async function approveById(id: string, e: React.MouseEvent): Promise<void> {
    setDeciding(id);
    popConfettiFromEvent(e);
    try {
      await store.decideApprove(id);
      await Promise.all([refreshApprovals(), refreshFounder()]);
      if (mounted.current) setPeek(null);
    } finally {
      if (mounted.current) setDeciding(null);
    }
  }

  async function rejectItem(item: ConsoleItem): Promise<void> {
    if (!item.requestId) return;
    setDeciding(item.requestId);
    try {
      await store.decideReject(item.requestId, CONSOLE.peek.notYetReason);
      await Promise.all([refreshApprovals(), refreshFounder()]);
      if (mounted.current) setPeek(null);
    } finally {
      if (mounted.current) setDeciding(null);
    }
  }

  function sendSteer(text: string): void {
    void store.sendMessage(text);
  }

  // --- peek drawer data ----------------------------------------------------------------------------
  const transcript: readonly PeekTranscriptLine[] = useMemo(() => {
    if (!peek || !peek.item.channelId) return [];
    const msgs = messagesByChannel[peek.item.channelId] ?? [];
    return msgs.map((m) => {
      const who = authorLabel(directory, m.authorMemberId);
      return {
        id: m.id,
        who,
        body: m.body,
        hue: agentColor(who),
        mine: m.authorMemberId === identity?.memberId,
      };
    });
  }, [peek, messagesByChannel, directory, identity]);

  const peekItem = peek?.item ?? null;
  const canCompose = !!peekItem?.channelId;
  const canApprove = peekItem?.kind === "waiting" && !!peekItem.requestId;

  return (
    <div className="console">
      <StandupPanel
        projects={model.projects}
        activeProjectId={activeProjectId}
        openProjectIds={openProjectIds}
        onToggleProject={toggleProject}
        onSelectProject={(p) => setActiveProjectId(p.id)}
        onOpenSettings={openSettings}
        onPeek={(item) => dive(item, "transcript")}
        filterNeedsYou={filterNeedsYou}
        onToggleFilter={() => setFilterNeedsYou((v) => !v)}
        activeItemKey={peek?.item.key ?? null}
        onOpenWorkspaceSettings={() => setShellSettingsOpen(true)}
        onSignOut={() => void store.logout()}
      />

      <main className="console__main">
        <header className="console__head">
          <h1 className="console__title">{headerTitle}</h1>
          {forecast && fc && (
            <span
              className="gauge"
              title={`${fc.budget.window} · ${fmtCents(fc.budget.estimatedCostCents)}${
                fc.budget.budgetCents > 0 ? ` of ${fmtCents(fc.budget.budgetCents)}` : ""
              }`}
            >
              <span className="gauge__bar">
                <span
                  className={`gauge__fill${forecast.atRisk ? " gauge__fill--risk" : ""}`}
                  style={{ width: `${Math.round(forecast.fraction * 100)}%` }}
                />
              </span>
              <span className="gauge__lbl">
                {fmtCents(fc.budget.estimatedCostCents)}
                {fc.budget.budgetCents > 0 ? ` / ${fmtCents(fc.budget.budgetCents)}` : ""}
              </span>
              <span className={`gauge__fc${forecast.atRisk ? " gauge__fc--risk" : ""}`}>
                {!forecast.hasCap ? CONSOLE.gauge.noCap : forecast.atRisk ? CONSOLE.gauge.atRisk : CONSOLE.gauge.onTrack}
              </span>
            </span>
          )}
          {fc && (
            <span className={`fleet-health${fc.attention.required ? " fleet-health--err" : ""}`}>
              <i aria-hidden="true" />
              {fc.attention.required ? CONSOLE.health.attention : CONSOLE.health.healthy}
            </span>
          )}
          <span className="console__sp" />
          {pendingCount > 0 && (
            <button className="waitchip" onClick={openFirstWaiting}>
              <span className="glyph-dot glyph-dot--wait" aria-hidden="true" />
              {consoleWaitingChip(pendingCount)}
            </button>
          )}
        </header>

        <Board
          columns={model.columns}
          onPeek={(item) => dive(item, "transcript")}
          onWhy={(item) => dive(item, "audit")}
        />
      </main>

      <PeekDrawer
        open={!!peek}
        title={peekItem?.title ?? ""}
        dept={peekItem?.channelName ?? null}
        agent={peekItem?.agentLabel ?? ""}
        hue={peekItem?.hue}
        kind={peekItem?.kind ?? null}
        initialMode={peek?.mode === "audit" ? "audit" : "steps"}
        transcript={transcript}
        audit={peekItem ? auditLines(peekItem) : []}
        askLine={canApprove && peekItem ? askLineOf(peekItem) : null}
        canCompose={canCompose}
        canApprove={canApprove}
        deciding={!!peekItem?.requestId && deciding === peekItem.requestId}
        onApprove={(e) => void (peekItem?.requestId && approveById(peekItem.requestId, e))}
        onReject={() => peekItem && void rejectItem(peekItem)}
        onClose={() => setPeek(null)}
        onSend={sendSteer}
      />

      <ProjectSettingsSheet
        open={settingsOpen}
        project={settingsProject}
        budgetWindow={fc?.budget.window}
        spentCents={fc?.budget.estimatedCostCents}
        budgetCents={fc?.budget.budgetCents}
        approverEmail={identity?.kind === "human" ? identity.displayName : null}
        onClose={() => setSettingsOpen(false)}
      />

      {/* #153 trial funnel: a hit cap surfaces the soft paywall nudge → the pricing overlay. */}
      {paywall && identity && (
        <SoftPaywall
          workspaceId={identity.workspaceId}
          onSeePlans={() => {
            store.dismissPaywall();
            setPricingOpen(true);
          }}
          onDismiss={() => store.dismissPaywall()}
        />
      )}

      {shellSettingsOpen && (
        <ShellOverlay title={CONSOLE.shell.settingsTitle} onClose={() => setShellSettingsOpen(false)}>
          <ConnectClaudePanel />
          <SlackConnectPanel />
        </ShellOverlay>
      )}

      {pricingOpen && (
        <ShellOverlay title={CONSOLE.shell.settingsTitle} onClose={() => setPricingOpen(false)}>
          <PricingPanel />
        </ShellOverlay>
      )}
    </div>
  );
}

/** A full-bleed overlay for the off-board surfaces (settings, pricing) — there is no nav to host them. */
function ShellOverlay({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="shell-overlay" role="dialog" aria-label={title}>
      <div className="shell-overlay__bar">
        <button className="btn btn--ghost" onClick={onClose}>
          {CONSOLE.shell.closeSettings}
        </button>
      </div>
      <div className="shell-overlay__body">{children}</div>
    </div>
  );
}
