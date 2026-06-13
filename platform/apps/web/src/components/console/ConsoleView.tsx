/**
 * The console — the product's primary surface (board + standup redesign, per the approved brand-book
 * mockup). Composition only: it reads the live seams and wires them into the presentational pieces.
 *
 *   · standup (left)   ← channels + directory (store) grouped by project, plus the status grammar
 *   · board (center)   ← live sessions (#147 mission control) · #13 approvals (pending/executed)
 *   · header gauge     ← #104 founder-console budget burn → on-track / at-risk forecast
 *   · while-you-were-out + reports ← the same #104 roll-up (the closest real seam to a daily brief)
 *   · peek drawer      ← the store's channel transcript + composer (steer the session)
 *
 * Approvals decide through `store.decideApprove` / `store.decideReject` — the real #13 gate, reconciled
 * against the server. No gate is weakened and no data is invented; surfaces with no real seam (a new
 * #173 brief endpoint) reuse the honest closest one rather than fabricate. All motion is reduced-motion
 * gated in the leaf components.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalRequestDto } from "@reload/shared";
import { useAppState, useStore } from "../../store/StoreContext.js";
import { authorLabel } from "../../store/store.js";
import { api } from "../../api/client.js";
import type { FounderConsoleDto, MissionControlDto } from "../../api/types.js";
import {
  BRAND,
  CONSOLE,
  VOICE,
  DEPARTMENT_SPECTRUM,
  agentColor,
  consoleOvernightSummary,
  consoleWaitingChip,
} from "../../brand.js";
import { popConfettiFromEvent } from "../../lib/confetti.js";
import { StandupPanel } from "./StandupPanel.js";
import { Board } from "./Board.js";
import { ReportsView } from "./ReportsView.js";
import { ProjectSettingsSheet } from "./ProjectSettingsSheet.js";
import { PeekDrawer, type PeekAuditLine, type PeekTranscriptLine } from "./PeekDrawer.js";
import {
  buildConsole,
  fmtCents,
  spendForecast,
  type ConsoleItem,
  type ConsoleNav,
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

export function ConsoleView(): React.JSX.Element {
  const { identity, channels, directory, messagesByChannel } = useAppState();
  const store = useStore();
  const workspaceId = identity?.workspaceId;

  const [mc, setMc] = useState<MissionControlDto | null>(null);
  const [fc, setFc] = useState<FounderConsoleDto | null>(null);
  const [pending, setPending] = useState<readonly ApprovalRequestDto[]>([]);
  const [shipped, setShipped] = useState<readonly ApprovalRequestDto[]>([]);

  const [view, setView] = useState<ConsoleNav>("board");
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [openProjectIds, setOpenProjectIds] = useState<ReadonlySet<string>>(new Set());
  const [filterNeedsYou, setFilterNeedsYou] = useState(false);
  const [peek, setPeek] = useState<PeekTarget | null>(null);
  const [settingsProject, setSettingsProject] = useState<ConsoleProject | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [wyoDismissed, setWyoDismissed] = useState(false);

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
      /* transient; the standup/board degrade to what's already shown */
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

  // Both the brief/spend snapshot AND the approvals queue refresh on the same 15s beat, so the board's
  // "waiting on you" lane never goes stale while the page sits open.
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

  function openPeek(item: ConsoleItem): void {
    if (item.channelId) void store.selectChannel(item.channelId);
    setPeek({ item, mode: "transcript" });
  }

  function openWhy(item: ConsoleItem): void {
    setPeek({ item, mode: "audit" });
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
    } finally {
      setDeciding(null);
    }
  }

  async function rejectItem(item: ConsoleItem): Promise<void> {
    if (!item.requestId) return;
    setDeciding(item.requestId);
    try {
      await store.decideReject(item.requestId, "Sent back for another pass.");
      await Promise.all([refreshApprovals(), refreshFounder()]);
    } finally {
      setDeciding(null);
    }
  }

  function sendSteer(text: string): void {
    void store.sendMessage(text);
  }

  // --- peek drawer data ----------------------------------------------------------------------------
  const transcript: readonly PeekTranscriptLine[] = useMemo(() => {
    if (!peek || peek.mode !== "transcript" || !peek.item.channelId) return [];
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

  const peekTitle = peek
    ? peek.mode === "audit"
      ? `${CONSOLE.peek.whyPrefix} · ${peek.item.agentLabel}`
      : peek.item.title
    : "";
  const peekStatus = peek ? (peek.mode === "audit" ? CONSOLE.peek.auditStatus : peek.item.meta) : "";
  const canCompose = !!peek && peek.mode === "transcript" && !!peek.item.channelId && peek.item.kind !== "shipped";

  const overnight = fc
    ? consoleOvernightSummary(shipped.length, pendingCount, fmtCents(fc.budget.estimatedCostCents))
    : "";

  return (
    <div className="console">
      <StandupPanel
        view={view}
        onSelectView={setView}
        projects={model.projects}
        activeProjectId={activeProjectId}
        openProjectIds={openProjectIds}
        onToggleProject={toggleProject}
        onSelectProject={(p) => setActiveProjectId(p.id)}
        onOpenSettings={openSettings}
        onPeek={openPeek}
        filterNeedsYou={filterNeedsYou}
        onToggleFilter={() => setFilterNeedsYou((v) => !v)}
        pendingCount={pendingCount}
        activeItemKey={peek?.item.key ?? null}
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
            <button className="waitchip" onClick={() => setView("board")}>
              <span className="glyph-dot glyph-dot--wait" aria-hidden="true" />
              {consoleWaitingChip(pendingCount)}
            </button>
          )}
        </header>

        {fc && !wyoDismissed && view === "board" && (
          <div className="wyo">
            <span className="wyo__t">{CONSOLE.wyo.title}</span>
            <span className="wyo__m">{overnight}</span>
            <span className="console__sp" />
            <button className="btn btn--ghost wyo__read" onClick={() => setView("reports")}>
              {CONSOLE.wyo.read}
            </button>
            <button className="iconbtn" aria-label={CONSOLE.wyo.dismiss} onClick={() => setWyoDismissed(true)}>
              ✕
            </button>
          </div>
        )}

        {view === "board" && (
          <div className="legend">
            {Object.entries(DEPARTMENT_SPECTRUM).map(([dept, hue]) => (
              <span key={dept} className="legend__item">
                <i className="legend__sw" style={{ background: hue }} aria-hidden="true" />
                {dept}
              </span>
            ))}
            <span className="legend__caption">{CONSOLE.legend.caption}</span>
          </div>
        )}

        {view === "board" ? (
          <Board
            columns={model.columns}
            onPeek={openPeek}
            onWhy={openWhy}
            onApprove={(item, e) => void (item.requestId && approveById(item.requestId, e))}
            onReject={(item) => void rejectItem(item)}
            decidingKey={deciding}
          />
        ) : view === "reports" ? (
          <ReportsView
            console={fc}
            onApprove={(id, e) => void approveById(id, e)}
            onPeekBrief={() => fc && setView("reports")}
            decidingId={deciding}
          />
        ) : (
          <div className="console__history">
            <div className="board__clear" role="status">
              <b>{CONSOLE.reports.handoverEmpty}</b>
            </div>
          </div>
        )}

        <div className="console__foot">{VOICE.signOff}</div>
      </main>

      <PeekDrawer
        open={!!peek}
        title={peekTitle}
        status={peekStatus}
        mode={peek?.mode ?? "transcript"}
        transcript={transcript}
        audit={peek && peek.mode === "audit" ? auditLines(peek.item) : []}
        canCompose={canCompose}
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
    </div>
  );
}
