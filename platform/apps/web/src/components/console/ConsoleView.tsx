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
import { api, ApiError, CHECKOUT_RETURN_PARAM } from "../../api/client.js";
import type { FounderConsoleDto, MissionControlDto } from "../../api/types.js";
import { BRAND, CONSOLE, agentColor, consoleWaitingChip } from "../../brand.js";
import { popConfettiFromEvent } from "../../lib/confetti.js";
import { ConnectClaudePanel } from "../ConnectClaudePanel.js";
import { SlackConnectPanel } from "../SlackConnectPanel.js";
import { ExternalAccountsPanel } from "../ExternalAccountsPanel.js";
import { ConnectionsPanel } from "../ConnectionsPanel.js";
import { BrandKitPanel } from "../BrandKitPanel.js";
import { BillingSettingsPanel } from "../BillingSettingsPanel.js";
import { PricingPanel } from "../PricingPanel.js";
import { SoftPaywall } from "../site/SoftPaywall.js";
import { StandupPanel } from "./StandupPanel.js";
import { Board } from "./Board.js";
import { BriefComposer, type BriefOutcomeKind } from "./BriefComposer.js";
import { ConsoleEmptyState, type SeedError } from "./ConsoleEmptyState.js";
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

/** Default cool-off when a 429 carries no `Retry-After` (matches the server's advertised default, #221). */
const SEED_RETRY_FALLBACK_SECONDS = 30;

/**
 * Turn a failed first-run seed into an actionable {@link SeedError} (#221): a 429 becomes a held countdown
 * (honouring the server's `Retry-After`), an unreachable/rejected API becomes a "connect Claude" route, and
 * anything else stays a quiet generic retry. Keeps the dead "give it another go → re-hit the limit" loop out.
 */
function classifySeedError(err: unknown): SeedError {
  if (err instanceof ApiError) {
    if (err.status === 429) {
      return { kind: "rate", retryAfterSeconds: err.retryAfterSeconds ?? SEED_RETRY_FALLBACK_SECONDS };
    }
    // Server reached but the team can't run (no connected runtime / unavailable backend) → route to Connect.
    return { kind: "connect" };
  }
  return { kind: "generic" };
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
  // Set when the customer lands back from a completed hosted checkout (`?checkout=success`).
  const [checkoutReturned, setCheckoutReturned] = useState(false);

  // First-run activation: the seed that hires the founding team (the #123/#138 department seam).
  const [seeding, setSeeding] = useState(false);
  const [seeded, setSeeded] = useState(false);
  const [seedError, setSeedError] = useState<SeedError | null>(null);
  // Rate-limit cool-off (#221/#227), lifted here so it is the ONE authoritative hold shared by both seed
  // affordances (the empty-state CTA and the always-present left-rail control). Seeded from the server's
  // Retry-After and ticked down; while it is > 0 every seed entry point is blocked, so a held click can
  // never re-fire into the limit or reset the window. A new rate error only ever arrives from a click that
  // actually fired (i.e. after the hold elapsed), so re-seeding the countdown from it is always honest.
  const [seedCoolOff, setSeedCoolOff] = useState(0);
  useEffect(() => {
    if (seedError?.kind !== "rate") {
      setSeedCoolOff(0);
      return;
    }
    setSeedCoolOff(seedError.retryAfterSeconds);
    const timer = window.setInterval(() => {
      setSeedCoolOff((s) => (s <= 1 ? 0 : s - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [seedError]);
  const seedHeld = seedCoolOff > 0;

  // Guards every async setState so a poll that resolves after unmount is a no-op (no leak / no warning).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Hosted checkout returns the customer to `…/?checkout=success` (#215). Confirm the upgrade, clear any
  // paywall that triggered it, refresh the spend snapshot so the new cap shows, and strip the query flag so
  // a reload doesn't re-fire the banner. routing.tsx exposes only the pathname, so read search directly.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get(CHECKOUT_RETURN_PARAM) !== "success") return;
    setCheckoutReturned(true);
    store.dismissPaywall();
    void refreshFounder();
    params.delete(CHECKOUT_RETURN_PARAM);
    const qs = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
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

  // #248: the owner can stop a runaway agent straight from the board. The backend cancel works even
  // for an orphaned/stuck session (it force-finalizes the row), so the WIP card always clears. Refresh
  // mission control immediately so the stopped session drops off the board.
  async function stopSession(sessionId: string): Promise<void> {
    if (!workspaceId) return;
    try {
      await api.missionControl.stop(workspaceId, sessionId);
    } catch {
      /* best-effort; the next poll reflects the terminal state regardless */
    }
    try {
      const next = await api.missionControl.get(workspaceId);
      if (mounted.current) setMc(next);
    } catch {
      /* transient */
    }
  }

  // The console is "activated" once the workspace has ≥1 venture (#226), read from the #104 pipeline
  // roll-up. This — NOT the live-session count or a seed flag — is what drives the first-run empty desk and
  // the rendered PROJECTS: a workspace with a venture is never an empty desk, with or without a reload, and
  // its departments render even before the first welcome session spawns (created-but-paused).
  const hasVenture = (fc?.venturePipeline.total ?? 0) >= 1;

  const model = useMemo(
    () =>
      buildConsole({
        liveSessions: mc?.sessions ?? [],
        pending,
        shipped,
        channels,
        directory,
        activated: hasVenture,
      }),
    [mc, pending, shipped, channels, directory, hasVenture],
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

  /**
   * First-run activation: hire the founding team and light up the board. Runs the REAL #123/#138 seed
   * (seven department leads, each launching its first welcome session — `welcomeTasks`), then reloads the
   * channels and pulls the live seams once so the board fills in immediately rather than on the next poll.
   * Idempotent at the seam, so a re-click never duplicates the fleet; failures surface a quiet retry line.
   */
  async function startVenture(): Promise<void> {
    // Block while a seed is in flight OR a rate-limit hold is live (#227): a held click must not fire a
    // request at all — that is what kept re-hitting the limit and resetting the window. The hold elapses on
    // its own (seedCoolOff ticks to 0), after which a click can fire again.
    if (!workspaceId || seeding || seedHeld) return;
    setSeeding(true);
    setSeedError(null);
    try {
      await api.department.seed(workspaceId, { welcomeTasks: true });
      await store.bootstrap();
      const [next] = await Promise.all([
        api.missionControl.get(workspaceId).catch(() => null),
        refreshApprovals(),
        refreshFounder(),
      ]);
      if (!mounted.current) return;
      if (next) setMc(next);
      setSeeded(true);
    } catch (err) {
      if (mounted.current) setSeedError(classifySeedError(err));
    } finally {
      if (mounted.current) setSeeding(false);
    }
  }

  /**
   * #235: the owner briefs a department lead. Posts the goal into the lead's channel and launches a REAL
   * session down the audited @mention path, then pulls the live seams ONCE so the board fills immediately
   * (the "Work in progress" lane) rather than on the next 4s poll. Never throws — the composer renders the
   * outcome: a launched session, a connect-prompt (no Claude connected), or a quiet error (e.g. a budget /
   * kill-switch 402/429, or the fleet not yet hired).
   */
  async function briefLead(lead: string, goal: string): Promise<BriefOutcomeKind> {
    if (!workspaceId) return "error";
    try {
      const res = await api.department.brief(workspaceId, { lead, goal });
      const [next] = await Promise.all([
        api.missionControl.get(workspaceId).catch(() => null),
        refreshApprovals(),
      ]);
      if (mounted.current && next) setMc(next);
      if (res.launched.length > 0) return "launched";
      if (res.connectPrompted.length > 0) return "connect";
      return "launched";
    } catch {
      return "error";
    }
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
        onNewProject={() => void startVenture()}
        newProjectBusy={seeding || seedHeld}
      />

      <main className="console__main">
        {checkoutReturned && (
          <div className="checkout-banner" role="status">
            <span>{CONSOLE.checkoutReturn.success}</span>
            <button className="checkout-banner__dismiss" onClick={() => setCheckoutReturned(false)}>
              {CONSOLE.checkoutReturn.dismiss}
            </button>
          </div>
        )}
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
          {/* The in-app conversion path (#215): a trial user approaching the cap upgrades in one click. */}
          {fc && (
            <button
              className={`gauge-upgrade${forecast?.atRisk ? " gauge-upgrade--risk" : ""}`}
              onClick={() => setPricingOpen(true)}
            >
              {CONSOLE.gauge.upgrade}
            </button>
          )}
          {fc && (
            <span
              className={`fleet-health${fc.attention.required ? " fleet-health--err" : ""}`}
              title={fc.attention.required ? fc.attention.reasons.join(" · ") : undefined}
            >
              <i aria-hidden="true" />
              {fc.attention.required ? CONSOLE.health.attention : CONSOLE.health.healthy}
              {fc.attention.required && fc.attention.reasons.length > 0 && (
                <span className="fleet-health__reason"> — {fc.attention.reasons[0]}</span>
              )}
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

        {/* #230: the "why is nothing running?" diagnostic — server-classified (spawn-and-die / no work /
            idle) so the console NEVER sits silently on "clocking in". Shows on the clocking-in panel AND the
            board (it sits above both), with the classified exit reason of recent failures so a dead fleet is
            visible, not swallowed. "running" (board is filling) and "no_venture" (the first-run pitch already
            speaks for itself) render nothing here. Copy is server-sourced data, not chrome literals. */}
        {mc?.diagnostic && mc.diagnostic.state !== "running" && mc.diagnostic.state !== "no_venture" && (
          <div className={`consolediag consolediag--${mc.diagnostic.state}`} role="status">
            <p className="consolediag__headline">{mc.diagnostic.headline}</p>
            <p className="consolediag__detail">{mc.diagnostic.detail}</p>
            {mc.recentFailures && mc.recentFailures.length > 0 && (
              <ul className="consolediag__failures">
                {mc.recentFailures.slice(0, 3).map((f) => (
                  <li key={f.id} className="consolediag__failure">
                    {f.headline}{" "}
                    <code className="consolediag__exit">{`${f.failureClass} · exit ${f.exitCode ?? "n/a"}`}</code>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* #226: the empty desk is driven strictly off "the workspace has a venture", never the session
            count or a seed flag. A workspace with a venture always renders its board/PROJECTS — even with
            zero live sessions (created-but-paused) and across a reload. The desk shows only for a genuine
            first run: no venture and nothing in flight. */}
        {!hasVenture && model.projects.length === 0 ? (
          <ConsoleEmptyState
            onStart={() => void startVenture()}
            busy={seeding}
            seeded={seeded}
            error={seedError}
            coolOff={seedCoolOff}
            onConnect={() => setShellSettingsOpen(true)}
          />
        ) : (
          <>
            {/* #235: the owner's always-present brief composer — point a lead at a goal and the board fills.
                Replaces the passive "between tasks — @mention a lead" board with a real working control. */}
            <BriefComposer leads={CONSOLE.brief.leads} onBrief={briefLead} />
            <Board
              columns={model.columns}
              onPeek={(item) => dive(item, "transcript")}
              onWhy={(item) => dive(item, "audit")}
              onStop={(item) => void stopSession(item.key)}
            />
          </>
        )}
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
          <ConnectionsPanel />
          <ExternalAccountsPanel />
          <BrandKitPanel />
          <BillingSettingsPanel />
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
