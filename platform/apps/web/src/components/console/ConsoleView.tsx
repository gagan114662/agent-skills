/**
 * The console — the product's one and only authed surface (console v5). The whole app is two panes:
 *
 *   · LEFT  (StandupPanel)  ← projects → sessions, the Conductor anatomy + account utilities
 *   · CENTER (this board)   ← one kanban: Work in progress / Spend approval / Done
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
import type { ApprovalRequestDto, ApprovalStatus } from "@reload/shared";
import { useAppState, useStore } from "../../store/StoreContext.js";
import { authorLabel } from "../../store/store.js";
import { api, ApiError, CHECKOUT_RETURN_PARAM } from "../../api/client.js";
import type { ClaudeConnectionHealth, FounderConsoleDto, MissionControlDto } from "../../api/types.js";
import { BRAND, CONSOLE, agentColor, consoleRunningPill, consoleWaitingChip } from "../../brand.js";
import { popConfettiFromEvent } from "../../lib/confetti.js";
import { ConnectClaudePanel } from "../ConnectClaudePanel.js";
import { SlackConnectPanel } from "../SlackConnectPanel.js";
import { ExternalAccountsPanel } from "../ExternalAccountsPanel.js";
import { ConnectionsPanel } from "../ConnectionsPanel.js";
import { GardenPanel } from "../GardenPanel.js";
import { BrandKitPanel } from "../BrandKitPanel.js";
import { MarketingTargetPanel } from "../MarketingTargetPanel.js";
import { BillingSettingsPanel } from "../BillingSettingsPanel.js";
import { BudgetSettingsPanel } from "../BudgetSettingsPanel.js";
import { PolicyControlCenter } from "../PolicyControlCenter.js";
import { PricingPanel } from "../PricingPanel.js";
import { ApprovalsPanel } from "../approvals/ApprovalsPanel.js";
import { CommandDock } from "../CommandDock.js";
import { FirstRunChecklist } from "../FirstRunChecklist.js";
import { deriveFirstRunChecklist, firstRunComplete, type FirstRunStepKey } from "../../lib/firstrun-checklist.js";
import { loadFirstRunPrefs, saveFirstRunPrefs } from "../../lib/firstrun-prefs.js";
import {
  SETTINGS_SECTION_ATTR,
  firstRunSettingsSection,
  scrollToSettingsSection,
  type SettingsSection,
} from "../../lib/settings-sections.js";
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
import { humanActionLabel } from "./deliverable.js";
import {
  FIRST_RUN_AUTORUN_ENABLED,
  firstRunPanel,
  shouldAutoRunFirstRun,
} from "./firstrun.js";
import {
  COORDINATION_OWNER_WORKSPACE_ID,
  COORDINATION_UI_ENABLED,
  shouldShowCoordination,
} from "./coordination-flag.js";
import { CoordinationView } from "./CoordinationView.js";
import {
  VENTURE_INTAKE_ENABLED,
  VENTURE_INTAKE_OWNER_WORKSPACE_ID,
  shouldShowVentureIntake,
} from "./venture-intake-flag.js";
import { VentureBriefPanel } from "./VentureBriefPanel.js";
import { InboundLeadsPanel } from "./InboundLeadsPanel.js";
import { ShortFormBlitzSurface } from "./ShortFormBlitzSurface.js";
import { MissionCommandCenter } from "./MissionCommandCenter.js";
import {
  SHORT_FORM_BLITZ_ENABLED,
  SHORT_FORM_BLITZ_OWNER_WORKSPACE_ID,
  shouldShowShortFormBlitz,
} from "./short-form-blitz-flag.js";
import { ConnectHealthChip } from "./ConnectHealthChip.js";
import {
  CONNECT_HEALTH_OWNER_WORKSPACE_ID,
  CONNECT_HEALTH_UI_ENABLED,
  shouldShowConnectHealth,
} from "./connect-health-flag.js";
import { VersionMismatchBanner } from "./VersionMismatchBanner.js";
import {
  decideVersionParity,
  shouldShowVersionCheck,
  VERSION_CHECK_OWNER_WORKSPACE_ID,
  VERSION_CHECK_UI_ENABLED,
  WEB_BUILD_SHA,
  type VersionParityVerdict,
} from "./version-check.js";

interface PeekTarget {
  item: ConsoleItem;
  mode: "transcript" | "audit";
}

/** The receipts we actually hold for an item → the "why?" audit trail (nothing fabricated). */
function auditLines(item: ConsoleItem): PeekAuditLine[] {
  const lines: PeekAuditLine[] = [{ label: `Owner · ${item.agentLabel}`, tag: "agent" }];
  if (item.channelName) lines.push({ label: `Department · #${item.channelName}`, tag: "scope" });
  // #302: a HUMAN action label, never the raw `x.y` type id.
  if (item.actionType) lines.push({ label: `Action · ${humanActionLabel(item.actionType)} · held for your yes`, tag: "gate" });
  if (item.amount != null) lines.push({ label: `Amount · ${fmtCents(item.amount)}`, tag: "budget" });
  if (item.costCents !== undefined) lines.push({ label: `Spend so far · ${fmtCents(item.costCents)}`, tag: "budget" });
  lines.push({ label: `Status · ${item.meta}`, tag: item.kind });
  return lines;
}

/**
 * The concrete "what you're approving" line shown above the Approve / Not yet pair (waiting items).
 * Prefers the deliverable's plain consequence line (#302); otherwise a human action label (never a raw
 * type id), with the amount for money actions.
 */
function askLineOf(item: ConsoleItem): string {
  if (item.consequence) return item.consequence;
  const action = humanActionLabel(item.actionType);
  return item.amount != null ? `${action} · ${fmtCents(item.amount)}` : action;
}

/** Default cool-off when a 429 carries no `Retry-After` (matches the server's advertised default, #221). */
const SEED_RETRY_FALLBACK_SECONDS = 30;
export const FIRST_RUN_SEED_TIMEOUT_MS = 30_000;

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

export function ConsoleView({
  firstRunSeedTimeoutMs = FIRST_RUN_SEED_TIMEOUT_MS,
}: {
  firstRunSeedTimeoutMs?: number;
} = {}): React.JSX.Element {
  const { identity, channels, directory, messagesByChannel, paywall, activeChannelId } = useAppState();
  const store = useStore();
  const workspaceId = identity?.workspaceId;
  // #365: the connection-health chip shows only for the named owner workspace (fail-closed default-OFF), so
  // prod (which sets no env) is byte-for-byte the board it is today. Declared here so the health-fetch
  // effect below can gate on it.
  const connectHealthEnabled = shouldShowConnectHealth({
    flagOn: CONNECT_HEALTH_UI_ENABLED,
    ownerWorkspaceId: CONNECT_HEALTH_OWNER_WORKSPACE_ID,
    workspaceId,
  });
  // #366 deploy freshness: surface a stale-bundle vs newer-API divergence (preview-vs-prod confusion) for
  // the named owner workspace only (fail-closed default-OFF), so prod with no env is byte-for-byte today.
  const versionCheckEnabled = shouldShowVersionCheck({
    flagOn: VERSION_CHECK_UI_ENABLED,
    ownerWorkspaceId: VERSION_CHECK_OWNER_WORKSPACE_ID,
    workspaceId,
  });

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
  // #506: which section the settings overlay deep-links to on open (null = the top). "Set brand" aims it at
  // the Brand kit section so the user lands there instead of scrolling past every other section.
  const [shellSettingsSection, setShellSettingsSection] = useState<SettingsSection | null>(null);
  const [approvalsOpen, setApprovalsOpen] = useState(false);
  // #462: which status the Approvals inbox opens to — "pending" from the "waiting on you" pill, "executed"
  // (the decision history) from the members-rail decisions counter.
  const [approvalsInitialStatus, setApprovalsInitialStatus] = useState<ApprovalStatus>("pending");
  const [pricingOpen, setPricingOpen] = useState(false);
  const [policyBusy, setPolicyBusy] = useState(false);
  // #479 first-run checklist: real setup signals (brand kit set / an account connected). Fetched once; the
  // run + approve signals come from already-loaded state below.
  const [targetSet, setTargetSet] = useState(false);
  const [brandSet, setBrandSet] = useState(false);
  const [hasConnection, setHasConnection] = useState(false);
  // #505: the checklist's dismissed/docked state is a per-user UI preference, hydrated from storage once we
  // know the workspace (effect below) and persisted on every Hide / collapse so it sticks across reloads and
  // channel switches instead of re-floating over the message area each visit.
  const [firstRunDismissed, setFirstRunDismissed] = useState(false);
  const [firstRunCollapsed, setFirstRunCollapsed] = useState(false);
  // #503: the failure diagnostic (#487) is dismissible so it can't, stacked under the first-run card, push
  // the channel below the fold on load. Dismissal is per-session and only hides the banner — the underlying
  // failure state still drives the rest of the surface; the diagnostic is reachable again on reload.
  const [diagDismissed, setDiagDismissed] = useState(false);
  // #352/#372/#378: the agent-coordination surface (reload.chat-style channels/threads/members + live
  // sessions), gated default-OFF and owner-workspace-first — it renders for nobody unless this deployment
  // names the owner workspace AND this is that workspace. No new backend: it re-mounts the existing
  // coordination components which self-wire to the channels/messages/directory store and the #147
  // mission-control seam.
  //
  // #378 makes the reload.chat surface the WHOLE app for the named owner: there is no Coordination/Board
  // toggle and no projects/task sidebar — chat IS the product. When the gate is off (prod sets no
  // coordination env) the board renders byte-for-byte as it does today, so there is no behaviour to choose.
  // #365: the owner's Claude connection-health signal (connected / not connected / token expired), shown
  // as a header chip ONLY for the named owner workspace (default-OFF, owner-first via connect-health-flag).
  const [claudeHealth, setClaudeHealth] = useState<ClaudeConnectionHealth | null>(null);
  // #366: the web↔API build-parity verdict (null until the API /version is fetched). Only a CONFIRMED
  // mismatch ever renders a banner; match/unknown stay silent.
  const [versionParity, setVersionParity] = useState<VersionParityVerdict | null>(null);
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

  // First-run auto-deliverable (#301): on a fresh board the console quietly runs ONE safe, no-spend
  // deliverable (Scout audits the owner's own site) so a useful card appears with zero setup. `autoRunning`
  // drives the calm "warming up" panel (#299); the attempts ref bounds the silent background retry.
  const [autoRunning, setAutoRunning] = useState(false);
  const autoRunAttempts = useRef(0);
  const autoRunInFlight = useRef(false);
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

  // #365/#916: refresh the token-free Claude connection-health signal on mount and whenever Settings closes.
  // The header chip remains owner-flagged, but the first-run hire gate needs this for every workspace so a
  // new customer cannot reach a "team ready" state while the real runtime prerequisite is absent.
  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    void api
      .getClaudeHealth()
      .then((r) => live && mounted.current && setClaudeHealth(r.health))
      .catch(() => {
        /* leave prior snapshot; the chip never shows a wrong/faked state */
      });
    return () => {
      live = false;
    };
  }, [connectHealthEnabled, workspaceId, shellSettingsOpen]);

  // #366: fetch the API's running build SHA once (owner workspace only) and compare it to this bundle's
  // build stamp. A transient failure or an unstamped side resolves to "unknown" → the banner stays silent;
  // only a confirmed divergence raises it. No polling — a deploy mismatch is steady-state, not a blip.
  useEffect(() => {
    if (!versionCheckEnabled) return;
    let live = true;
    void api
      .getVersion()
      .then((r) => {
        if (!live || !mounted.current) return;
        setVersionParity(decideVersionParity({ webSha: WEB_BUILD_SHA, apiSha: r.version }));
      })
      .catch(() => {
        /* unreachable/old API → leave silent; we never fabricate a freshness claim (#200 FM#2) */
      });
    return () => {
      live = false;
    };
  }, [versionCheckEnabled]);

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

  // The board is shown (not the no-venture empty-state pitch, which owns its own guided activation). The
  // first-run auto-deliverable only applies once the owner is on a real board with departments (#301).
  const boardShown = !(!hasVenture && model.projects.length === 0);
  const seedAwaitingBoard = seeded && !hasVenture && model.projects.length === 0;

  // #940: after a successful hire, the empty desk must not spin forever. If no work appears before the
  // activation timeout and Claude is not confirmed connected, surface the real blocker with recovery CTAs.
  useEffect(() => {
    if (!seedAwaitingBoard || claudeHealth?.state === "connected") return;
    const id = window.setTimeout(() => {
      if (mounted.current) setSeedError({ kind: "timeout-connect" });
    }, firstRunSeedTimeoutMs);
    return () => window.clearTimeout(id);
  }, [seedAwaitingBoard, claudeHealth?.state, firstRunSeedTimeoutMs]);

  // #301: auto-run the safe first deliverable on a fresh-but-ready board, then silently retry only while a
  // transient runner failure is in play (#299). Re-evaluated on every poll; `shouldAutoRunFirstRun` guards
  // against double-firing, idle boards, and the attempt cap, so this never spams the seam.
  useEffect(() => {
    if (
      !shouldAutoRunFirstRun({
        flagOn: FIRST_RUN_AUTORUN_ENABLED,
        hasWorkspace: !!workspaceId,
        boardShown,
        liveCount: mc?.sessions.length ?? 0,
        deliverableCount: model.columns.waiting.length + model.columns.shipped.length,
        busy: autoRunning || seeding,
        attempts: autoRunAttempts.current,
        diagnosticState: mc?.diagnostic?.state ?? null,
      })
    ) {
      return;
    }
    void autoRunFirstDeliverable();
  }, [
    workspaceId,
    boardShown,
    autoRunning,
    seeding,
    mc?.sessions.length,
    mc?.diagnostic?.state,
    model.columns.waiting.length,
    model.columns.shipped.length,
  ]);

  const pendingCount = pending.length;
  // #384: the live indicator reduced to a small "N running" pill (never a table above the feed). Reads the
  // mission-control snapshot ConsoleView already polls (#147) — no extra fetch, no new seam.
  const runningCount = mc?.sessions.length ?? 0;
  const forecast = fc ? spendForecast(fc.budget) : null;
  // #352: the coordination surface shows only when the deployment flag is on AND this is the named owner
  // workspace (fail-closed — default OFF, named-nobody = nobody). When off, the button never renders and the
  // overlay can never open, so prod (which sets no coordination env) is byte-for-byte the board it is today.
  const coordinationEnabled = shouldShowCoordination({
    flagOn: COORDINATION_UI_ENABLED,
    ownerWorkspaceId: COORDINATION_OWNER_WORKSPACE_ID,
    workspaceId,
  });
  // #378: when coordination is enabled for the named owner, the reload.chat surface is the WHOLE app — no
  // toggle, no board, no projects/task sidebar. Fail-closed: when the gate is off this is always false, so
  // production (no coordination env) is byte-for-byte the board it is today.
  const showCoordinationSurface = coordinationEnabled;
  // #387 venture-intake surface: the owner-facing "Brief a venture" panel mounts only when the default-OFF,
  // owner-workspace-first venture-intake web flag resolves on for this workspace (fail-closed — named-nobody
  // = nobody). The server submit route is also gated (409 when off), so prod (which sets no venture-intake
  // env) is byte-for-byte the board it is today.
  const ventureIntakeEnabled = shouldShowVentureIntake({
    flagOn: VENTURE_INTAKE_ENABLED,
    ownerWorkspaceId: VENTURE_INTAKE_OWNER_WORKSPACE_ID,
    workspaceId,
  });
  // #744 short-form Blitz queue + content calendar: default-OFF and owner-workspace-first, reading through
  // an injected publishing/video seam. With no env set, the board is unchanged and no seam reads occur.
  const shortFormBlitzEnabled = shouldShowShortFormBlitz({
    flagOn: SHORT_FORM_BLITZ_ENABLED,
    ownerWorkspaceId: SHORT_FORM_BLITZ_OWNER_WORKSPACE_ID,
    workspaceId,
  });
  // #480: mirror the mission-control poll's ACTIVE sessions into the store so each channel can show
  // "{agent} is working…" in-channel, not just the single global pill. Provisioning + running count as
  // active. setLiveSessions is a no-op when unchanged, so this never forces a needless channel re-render.
  useEffect(() => {
    const active = (mc?.sessions ?? [])
      .filter((s) => s.status === "running" || s.status === "provisioning")
      .map((s) => ({
        id: s.id,
        channelId: s.channelId,
        agentMemberId: s.agentMemberId,
        status: s.status,
        agentStatus: s.agentStatus,
      }));
    store.setLiveSessions(active);
  }, [mc, store]);

  // #479/#950 first-run checklist: fetch the setup signals that aren't already in state (marketing target,
  // brand kit, any connected account), once, only on the coordination surface — so the board makes no extra
  // fetch when the checklist is not mounted. A failure leaves the step actionable.
  // Re-runs only when the surface flips on; a failure leaves the signal false (the step stays actionable).
  useEffect(() => {
    if (!showCoordinationSurface || !workspaceId) return;
    let live = true;
    void api.getMarketingTarget().then((t) => {
      if (live) setTargetSet(t.configured);
    }).catch(() => {});
    void api.getBrandKit().then((b) => {
      if (live) setBrandSet(b.connected);
    }).catch(() => {});
    void api.getConnections().then((c) => {
      if (live) setHasConnection(c.connections.some((conn) => conn.connected));
    }).catch(() => {});
    return () => {
      live = false;
    };
  }, [showCoordinationSurface, workspaceId]);

  // #505: hydrate the checklist's per-user dismissed/docked state once we know the workspace, so a card the
  // user hid (or docked to its compact bar) stays that way across reloads and channel switches.
  useEffect(() => {
    if (!workspaceId) return;
    const prefs = loadFirstRunPrefs(workspaceId);
    setFirstRunDismissed(prefs.dismissed);
    setFirstRunCollapsed(prefs.collapsed);
  }, [workspaceId]);

  // #479: derive the run + approve signals from already-loaded state. "An agent ran" is true once any
  // agent-authored message exists, a session is live, or a result/approval has appeared (each downstream of a
  // real run). "A result was approved" is true once an approval has executed (the `shipped` slice).
  const agentRan =
    runningCount > 0 ||
    shipped.length > 0 ||
    pending.length > 0 ||
    Object.values(messagesByChannel).some((ms) => ms.some((m) => directory[m.authorMemberId]?.kind === "agent"));
  const firstRunSteps = deriveFirstRunChecklist({
    targetSet,
    brandSet,
    claudeConnected: claudeHealth?.state === "connected",
    hasConnection,
    agentRan,
    resultApproved: shipped.length > 0,
  });
  // Only on the reload.chat surface, and only until every step is real or the user hides it.
  const showFirstRun = showCoordinationSurface && !firstRunDismissed && !firstRunComplete(firstRunSteps);
  // #505: persist a dismiss/dock so it sticks per user. We only WRITE on an explicit user action (Hide /
  // collapse), never in the hydrate effect, so there's no load→save echo to fight.
  function dismissFirstRun(): void {
    setFirstRunDismissed(true);
    saveFirstRunPrefs(workspaceId, { dismissed: true, collapsed: firstRunCollapsed });
  }
  function toggleFirstRunCollapsed(): void {
    setFirstRunCollapsed((prev) => {
      const next = !prev;
      saveFirstRunPrefs(workspaceId, { dismissed: firstRunDismissed, collapsed: next });
      return next;
    });
  }
  // #503: the runtime-failure banner shows on the coordination surface until the user dismisses it.
  const showDiag = showCoordinationSurface && mc?.diagnostic?.state === "sessions_failing" && !diagDismissed;
  function onFirstRunAction(key: FirstRunStepKey): void {
    const section = firstRunSettingsSection(key);
    if (section) openShellSettings(section); // #506: deep-link "Set brand"/"Connect" to their section
    else if (key === "approve") setApprovalsOpen(true);
    else dismissFirstRun(); // "run": the composer is right here — get out of the way
  }

  const activeProject = model.projects.find((p) => p.id === activeProjectId) ?? null;
  // #473: on the reload.chat coordination surface the top-left title MUST track the open channel (what
  // MessagePane shows), not `activeProjectId` — the board's column selection, which the chat sidebar never
  // touches. Binding to the project left the header showing a stale #content/#seo while the pane showed the
  // real channel. Off the coordination surface (the board) the project-based title is unchanged.
  const activeChannel = activeChannelId ? channels.find((c) => c.id === activeChannelId) ?? null : null;
  const coordinationHeaderTitle = activeChannel
    ? activeChannel.kind === "dm"
      ? CONSOLE.coordination.dm.title
      : `#${activeChannel.name ?? "channel"}`
    : BRAND.name;
  const headerTitle = showCoordinationSurface
    ? coordinationHeaderTitle
    : activeProject
      ? `#${activeProject.name}`
      : BRAND.name;

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
    // #472: on the reload.chat surface there is no board to dive into — the "waiting on you" pill must open
    // the first-class Approvals inbox (Approve / Reject / Edit per pending action, showing exactly what will
    // publish/send/spend), not scroll to a plain agent message. On the board, keep diving into the transcript.
    if (showCoordinationSurface) {
      setApprovalsInitialStatus("pending");
      setApprovalsOpen(true);
      return;
    }
    const first = model.columns.waiting[0];
    if (first) dive(first, "transcript");
  }

  // #462: open the #13 decision LOG (executed/rejected history — the real audit behind the members-rail
  // "N decisions captured" counter), landing on the executed decisions.
  function openDecisionLog(): void {
    setApprovalsInitialStatus("executed");
    setApprovalsOpen(true);
  }

  function openSettings(project: ConsoleProject): void {
    setSettingsProject(project);
    setSettingsOpen(true);
  }

  // #506: open the shell settings overlay, optionally deep-linked to one section. Openers with no specific
  // target (the header gear, the connect-health chip) pass nothing and land at the top, as before.
  function openShellSettings(section: SettingsSection | null = null): void {
    setShellSettingsSection(section);
    setShellSettingsOpen(true);
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

  async function togglePolicyKillSwitch(next: boolean): Promise<void> {
    if (!workspaceId || policyBusy) return;
    setPolicyBusy(true);
    try {
      await api.setKillSwitch(workspaceId, next);
      await refreshFounder();
    } finally {
      if (mounted.current) setPolicyBusy(false);
    }
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
    if (claudeHealth?.state !== "connected") {
      openShellSettings("connect");
      return;
    }
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

  function retrySeededStart(): void {
    setSeeded(false);
    setSeedError(null);
    void startVenture();
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

  /**
   * #301: produce the first-run deliverable with zero setup. Hires the department leads quietly
   * (idempotent, no welcome sessions) so a lead exists to brief, then briefs Scout on the safe, no-spend
   * site audit down the same audited @mention path the owner's brief uses. Fully silent (#299): any
   * failure is swallowed — the calm "warming up" state plus the bounded retry cover it, never a raw error.
   */
  async function autoRunFirstDeliverable(): Promise<void> {
    if (!workspaceId || autoRunInFlight.current) return;
    autoRunInFlight.current = true;
    autoRunAttempts.current += 1;
    setAutoRunning(true);
    try {
      await api.department.seed(workspaceId, { welcomeTasks: false }).catch(() => undefined);
      await store.bootstrap().catch(() => undefined);
      await briefLead(CONSOLE.firstRun.autoLead, CONSOLE.firstRun.autoGoal);
    } catch {
      /* silent — #299: first-run failures degrade to the warming-up state, never a raw error */
    } finally {
      autoRunInFlight.current = false;
      if (mounted.current) setAutoRunning(false);
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
    <div className={`console${showCoordinationSurface ? " console--coord" : ""}`}>
      {/* #378: the reload.chat surface is the whole app — the projects/task sidebar (StandupPanel) is NOT
          rendered for the flagged owner. When the gate is off it renders exactly as today. */}
      {!showCoordinationSurface && (
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
          onOpenWorkspaceSettings={() => openShellSettings()}
          onSignOut={() => void store.logout()}
          onNewProject={() => void startVenture()}
          newProjectBusy={seeding || seedHeld}
        />
      )}

      <main className="console__main">
        {/* #366: a deploy-freshness strip — renders only on a CONFIRMED web↔API build mismatch (owner-first,
            default-OFF), so prod is byte-for-byte today until the owner opts in. */}
        {versionCheckEnabled && <VersionMismatchBanner verdict={versionParity} />}
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
          {/* #384: on the reload.chat surface the header is slim — the budget gauge, the Upgrade button, and
              the fleet-health banner are NOT shown here (they're reachable, unobtrusively, in Settings →
              Billing, which embeds the spend summary + the upgrade path). The board (gate OFF) keeps them
              exactly as today. Running status reduces to a small "N running" pill below; approvals stay a
              small "N waiting on you" chip. */}
          {!showCoordinationSurface && forecast && fc && (
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
          {!showCoordinationSurface && fc && (
            <button
              className={`gauge-upgrade${forecast?.atRisk ? " gauge-upgrade--risk" : ""}`}
              onClick={() => setPricingOpen(true)}
            >
              {CONSOLE.gauge.upgrade}
            </button>
          )}
          {!showCoordinationSurface && fc && (
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
          {/* #365: the connection-health chip — connected / not connected / token expired. Owner-first +
              default-OFF, so it is invisible in production until the owner opts in. When the fleet can't run
              it IS the button to Connect Claude (the one action that unlocks real agent runs). */}
          {connectHealthEnabled && (
            <ConnectHealthChip health={claudeHealth} onConnect={() => openShellSettings()} />
          )}
          <span className="console__sp" />
          {/* #384: the live indicator — a small, calm pill, not a sessions table. Shows only on the
              reload.chat surface and only when something is actually running. */}
          {showCoordinationSurface && runningCount > 0 && (
            <span className="runpill" title={CONSOLE.coordination.liveLabel}>
              <span className="runpill__dot" aria-hidden="true" />
              {consoleRunningPill(runningCount)}
            </span>
          )}
          {/* #378: the reload.chat surface is the whole app — the Coordination/Board toggle is gone. Approvals
              stay reachable via the "waiting on you" chip below; Settings + Sign out move into this header
              because the projects/task sidebar that used to host them isn't rendered here. */}
          {pendingCount > 0 && (
            <button className="waitchip" onClick={openFirstWaiting}>
              <span className="glyph-dot glyph-dot--wait" aria-hidden="true" />
              {consoleWaitingChip(pendingCount)}
            </button>
          )}
          {showCoordinationSurface && (
            <>
              <button className="btn btn--ghost btn--small" onClick={() => openShellSettings()}>
                {CONSOLE.coordination.shell.settings}
              </button>
              <button className="btn btn--ghost btn--small" onClick={() => void store.logout()}>
                {CONSOLE.coordination.shell.signOut}
              </button>
            </>
          )}
        </header>

        {/* #372: chat-first landing for the named owner workspace. When coordination is the chosen surface
            the owner lands directly in the reload.chat-style view (the team channel IS the home screen); the
            board — with all its #299/#301/#226 first-run behaviour — is the Board tab, unchanged. When the
            gate is off, `showCoordinationSurface` is always false, so this whole branch is dead in production
            and the board below is byte-for-byte what ships today. */}
        {showCoordinationSurface ? (
          <>
            {/* #503: the top-of-surface banners (the #487 failure diagnostic + the #479 first-run card) share
                ONE height-capped, scrollable rail so that — even stacked — they can never eat more than a
                slice of the viewport. The channel below (`.coord`, flex: 1) always keeps the rest, so the
                latest messages stay above the fold on first paint. */}
            {(showDiag || showFirstRun) && (
              <div className="console__banners">
                {/* #487: surface the mission-control failure diagnostic on the reload.chat surface too — the
                    board already shows it, but here the user only saw a 'running' pill that silently cleared.
                    When runs are failing to spawn, show the backend's human headline + detail (e.g. "I
                    couldn't start up — my runtime is missing a tool") so the user sees the failure and reason
                    without devtools. #503: compact + dismissible so it doesn't dominate the first screen. */}
                {showDiag && mc?.diagnostic && (
                  <div className="consolediag consolediag--sessions_failing consolediag--dismissible" role="alert">
                    <div className="consolediag__body">
                      <p className="consolediag__headline">{mc.diagnostic.headline}</p>
                      <p className="consolediag__detail">{mc.diagnostic.detail}</p>
                    </div>
                    <button
                      type="button"
                      className="consolediag__dismiss"
                      aria-label={CONSOLE.coordination.diagnostic.dismissLabel}
                      onClick={() => setDiagDismissed(true)}
                    >
                      {CONSOLE.coordination.diagnostic.dismiss}
                    </button>
                  </div>
                )}
                {showFirstRun && (
                  <FirstRunChecklist
                    steps={firstRunSteps}
                    collapsed={firstRunCollapsed}
                    onAction={onFirstRunAction}
                    onToggleCollapse={toggleFirstRunCollapsed}
                    onDismiss={dismissFirstRun}
                  />
                )}
              </div>
            )}
            <CoordinationView onOpenDecisions={openDecisionLog} onOpenSettings={() => setShellSettingsOpen(true)} />
          </>
        ) : (
          <>
        {/* #299/#301: the console NEVER renders raw runner / exit-code errors. While the first deliverable
            is being produced — or while a transient runner/spawn failure is being silently retried — it
            shows the calm, branded "warming up" panel (NO exit codes, NO internal failure-class names, no
            recent-failure list). A genuine no_work / idle lull keeps the server's calm, exit-code-free line.
            "running" (the board is filling) and "no_venture" (the first-run pitch speaks for itself) render
            nothing here. The root-cause runner/model fixes are owner-gated prod work (#292/#293); this is the
            graceful UI degrade that keeps a brand-new workspace from ever seeing a raw error. */}
        {(() => {
          const panel = firstRunPanel({ autoRunning, diagnosticState: mc?.diagnostic?.state ?? null });
          if (panel === "warming") {
            return (
              <div className="consolediag consolediag--warming" role="status">
                <p className="consolediag__headline">{CONSOLE.warmingUp.headline}</p>
                <p className="consolediag__detail">{CONSOLE.warmingUp.sub}</p>
              </div>
            );
          }
          if (panel === "diagnostic" && mc?.diagnostic) {
            return (
              <div className={`consolediag consolediag--${mc.diagnostic.state}`} role="status">
                <p className="consolediag__headline">{mc.diagnostic.headline}</p>
                <p className="consolediag__detail">{mc.diagnostic.detail}</p>
              </div>
            );
          }
          return null;
        })()}

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
            claudeConnected={claudeHealth?.state === "connected"}
            activationDiagnostic={seedAwaitingBoard ? (mc?.diagnostic ?? null) : null}
            coolOff={seedCoolOff}
            onConnect={() => openShellSettings()}
            onRetry={retrySeededStart}
          />
        ) : (
          <>
            {/* #235: the owner's always-present brief composer — point a lead at a goal and the board fills.
                Replaces the passive "between tasks — @mention a lead" board with a real working control. */}
            <MissionCommandCenter
              mission={mc}
              founder={fc}
              pendingCount={pendingCount}
              shippedCount={shipped.length}
              agentLabel={(memberId) => authorLabel(directory, memberId)}
            />
            <BriefComposer leads={CONSOLE.brief.leads} onBrief={briefLead} />
            {/* #387: brief ANY company idea into the #96 venture loop. Gated default-OFF owner-first — when
                off (prod / non-owner) this never renders, so the board is byte-for-byte unchanged. */}
            {ventureIntakeEnabled && workspaceId && (
              <VentureBriefPanel workspaceId={workspaceId} />
            )}
            {shortFormBlitzEnabled && workspaceId && (
              <ShortFormBlitzSurface workspaceId={workspaceId} />
            )}
            <InboundLeadsPanel />
            <Board
              columns={model.columns}
              onPeek={(item) => dive(item, "transcript")}
              onWhy={(item) => dive(item, "audit")}
              onStop={(item) => void stopSession(item.key)}
            />
          </>
        )}
          </>
        )}
      </main>

      {/* #381: the peek drawer and the per-project settings sheet are BOARD surfaces — they're opened only by
          board/standup affordances, none of which render on the chat-first coordination landing. Both are
          fixed, full-screen elements; leaving them mounted (even closed) put a stray overlay over the chat on
          landing. Don't render them when the reload.chat surface is the whole app. When the gate is OFF
          (production), `showCoordinationSurface` is always false, so the board renders them exactly as today. */}
      {!showCoordinationSurface && (
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
      )}

      {!showCoordinationSurface && (
        <ProjectSettingsSheet
          open={settingsOpen}
          project={settingsProject}
          budgetWindow={fc?.budget.window}
          spentCents={fc?.budget.estimatedCostCents}
          budgetCents={fc?.budget.budgetCents}
          approverEmail={identity?.kind === "human" ? identity.displayName : null}
          onClose={() => setSettingsOpen(false)}
        />
      )}

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
        <ShellOverlay
          title={CONSOLE.shell.settingsTitle}
          onClose={() => setShellSettingsOpen(false)}
          scrollToSection={shellSettingsSection}
        >
          {/* #506: each section is tagged so a CTA can deep-link straight to it (e.g. "Set brand" → brand). */}
          {/* #502: "What are we marketing?" leads — it's the brief the whole fleet reads. */}
          <div {...{ [SETTINGS_SECTION_ATTR]: "marketing" }}>
            <MarketingTargetPanel />
          </div>
          <div {...{ [SETTINGS_SECTION_ATTR]: "connect" }}>
            <ConnectClaudePanel />
          </div>
          <div {...{ [SETTINGS_SECTION_ATTR]: "slack" }}>
            <SlackConnectPanel />
          </div>
          <div {...{ [SETTINGS_SECTION_ATTR]: "connections" }}>
            <ConnectionsPanel />
          </div>
          <div {...{ [SETTINGS_SECTION_ATTR]: "garden" }}>
            <GardenPanel />
          </div>
          <div {...{ [SETTINGS_SECTION_ATTR]: "accounts" }}>
            <ExternalAccountsPanel />
          </div>
          <div {...{ [SETTINGS_SECTION_ATTR]: "brand" }}>
            <BrandKitPanel />
          </div>
          <div {...{ [SETTINGS_SECTION_ATTR]: "billing" }}>
            <BillingSettingsPanel />
          </div>
          <div {...{ [SETTINGS_SECTION_ATTR]: "policy" }}>
            <PolicyControlCenter
              killSwitchOn={fc?.switches.killSwitch ?? false}
              maintenanceOn={fc?.switches.maintenance.enabled ?? false}
              pendingExternalActions={pending.length}
              loggedDecisions={shipped.length}
              busy={policyBusy}
              onToggleKillSwitch={(next) => void togglePolicyKillSwitch(next)}
            />
          </div>
          <div {...{ [SETTINGS_SECTION_ATTR]: "budget" }}>
            <BudgetSettingsPanel />
          </div>
        </ShellOverlay>
      )}

      {pricingOpen && (
        <ShellOverlay title={CONSOLE.shell.settingsTitle} onClose={() => setPricingOpen(false)}>
          <PricingPanel />
        </ShellOverlay>
      )}

      {/* #472: the first-class Approvals inbox — the human governance surface for #13. Opened by the
          "waiting on you" pill on the reload.chat surface (where there is no board to host it). The panel
          shows each pending action's type / amount / requester and the Approve / Reject controls. */}
      {approvalsOpen && (
        <ShellOverlay title={CONSOLE.shell.approvalsTitle} onClose={() => setApprovalsOpen(false)}>
          <ApprovalsPanel initialStatus={approvalsInitialStatus} />
        </ShellOverlay>
      )}

      {/* #729: the floating command dock — one consistent set of quick actions + the light/dark theme toggle,
          present on both the board and the reload.chat surface. Visual only: these are shortcuts to existing
          overlays (approvals/settings) plus a palette swap; no new behaviour. */}
      <CommandDock
        onOpenApprovals={() => {
          setApprovalsInitialStatus("pending");
          setApprovalsOpen(true);
        }}
        onOpenSettings={() => openShellSettings()}
        pendingCount={pendingCount}
      />
    </div>
  );
}

/** A full-bleed overlay for the off-board surfaces (settings, pricing) — there is no nav to host them. */
function ShellOverlay({
  title,
  onClose,
  children,
  scrollToSection = null,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** #506: when set, the overlay scrolls this `data-settings-section` into view on open (deep-link target). */
  scrollToSection?: SettingsSection | null;
}): React.JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null);
  // The overlay mounts fresh each open, so a mount effect lands the deep-linked section once, then stays
  // out of the way (no re-scroll while the user reads).
  useEffect(() => {
    scrollToSettingsSection(bodyRef.current, scrollToSection);
  }, [scrollToSection]);

  return (
    <div className="shell-overlay" role="dialog" aria-label={title}>
      <div className="shell-overlay__bar">
        <button className="btn btn--ghost" onClick={onClose}>
          {CONSOLE.shell.closeSettings}
        </button>
      </div>
      <div className="shell-overlay__body" ref={bodyRef}>
        {children}
      </div>
    </div>
  );
}
