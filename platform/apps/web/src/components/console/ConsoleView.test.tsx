/**
 * Console (board + standup) integration. Mounts the container against the singleton api (the #104/#147
 * polled seams) the same way FounderPanel's test does, and the store's fake deps for the chat/approval
 * actions. Proves: the three board lanes render from real data; the header carries the spend gauge,
 * fleet-health, and the "N waiting on you" chip; a running card peeks open its drawer; the empty-approvals
 * moment shows the brand copy; and Approve decides through the real #13 gate (store.decideApprove), never
 * a shortcut.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ApprovalRequestDto } from "@reload/shared";
import { ConsoleView } from "./ConsoleView.js";
import { api, ApiError } from "../../api/client.js";
import type { Channel, FounderConsoleDto, MissionControlDto } from "../../api/types.js";
import { CONSOLE } from "../../brand.js";
import { renderWithStore, type FakeBackendOverrides } from "../../test/utils.js";

const mcDto = (over: Partial<MissionControlDto> = {}): MissionControlDto => ({
  sessions: [
    {
      id: "sess-1",
      channelId: "c1",
      agentMemberId: "ag1",
      status: "running",
      elapsedMs: 720_000,
      estimatedCostCents: 84,
      startedAt: null,
      progressAt: "2026-06-12T09:00:00Z",
    },
  ],
  count: 1,
  totalEstimatedCostCents: 84,
  rateCentsPerMinute: 7,
  costIsEstimate: true,
  ...over,
});

const fcDto = (over: Partial<FounderConsoleDto> = {}): FounderConsoleDto => ({
  workspaceId: "w1",
  generatedAtMs: 1_700_000_000_000,
  fleet: { activeSessions: 1, sessionsThisWindow: 3, globalInFlight: 1 },
  venturePipeline: { total: 2, active: 1, funded: 1, killed: 0, escalated: 0 },
  revenue: { currency: "usd", totalCents: 21000, paymentCount: 4, willingnessToPayCount: 2, hasWillingnessToPay: true },
  budget: { window: "2026-06", estimatedCostCents: 6100, budgetCents: 100000, overBudget: false, utilization: 0.061 },
  pendingApprovals: [],
  switches: { killSwitch: false, maintenance: { enabled: false } },
  attention: { required: false, reasons: [] },
  ...over,
});

/**
 * A genuine first-run founder console: no venture in the pipeline (#226). The empty desk is now driven
 * strictly off `venturePipeline.total === 0`, so the first-run tests must say so explicitly rather than
 * lean on an incidental empty board.
 */
const firstRunFc = (over: Partial<FounderConsoleDto> = {}): FounderConsoleDto =>
  fcDto({ venturePipeline: { total: 0, active: 0, funded: 0, killed: 0, escalated: 0 }, ...over });

const req = (over: Partial<ApprovalRequestDto> = {}): ApprovalRequestDto => ({
  id: "r1",
  workspaceId: "w1",
  requesterMemberId: "ag1",
  actionType: "external.send",
  payload: {},
  amount: null,
  summary: "Send launch email sequence",
  status: "pending",
  reason: null,
  decidedByMemberId: null,
  decidedAt: null,
  expiresAt: null,
  result: null,
  error: null,
  createdAt: "2026-06-12T09:00:00Z",
  updatedAt: "2026-06-12T09:00:00Z",
  ...over,
});

function mockSeams(opts: { pending?: ApprovalRequestDto[]; fc?: FounderConsoleDto; mc?: MissionControlDto } = {}): void {
  vi.spyOn(api.missionControl, "get").mockResolvedValue(opts.mc ?? mcDto());
  vi.spyOn(api, "getFounderConsole").mockResolvedValue(opts.fc ?? fcDto());
  vi.spyOn(api.approvals, "list").mockImplementation(async (_w: string, status?: string) =>
    status === "pending" ? (opts.pending ?? [req()]) : [],
  );
}

/**
 * Stub the #123/#138 department seams (seed + brief) so the #301 first-run auto-deliverable never hits a
 * real fetch when it fires on a fresh-but-ready board. Returns the brief spy so a test can assert the
 * auto-run actually briefed Scout.
 */
function mockDepartment() {
  vi.spyOn(api.department, "seed").mockResolvedValue({ channels: [], agents: [], welcomeTasks: [] });
  return vi.spyOn(api.department, "brief").mockResolvedValue({
    lead: "scout",
    department: "seo",
    channelId: "c-seo",
    messageId: "m1",
    launched: [{ personaId: "p1", handle: "scout", department: "seo", sessionId: "s1", taskId: "t1" }],
    connectPrompted: [],
  });
}

afterEach(() => vi.restoreAllMocks());

async function mount(opts?: Parameters<typeof mockSeams>[0], over?: FakeBackendOverrides) {
  mockSeams(opts);
  const utils = renderWithStore(<ConsoleView />, over);
  await act(async () => {
    await utils.store.bootstrap();
  });
  return utils;
}

describe("ConsoleView", () => {
  it("renders the three v5 board lanes from the live seams", async () => {
    await mount();
    // The lanes are the board's listitems, addressed by their column title (scoped so "Done" never
    // collides with the settings sheet's "Done" button).
    expect(await screen.findByRole("listitem", { name: CONSOLE.columns.running })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: CONSOLE.columns.waiting })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: CONSOLE.columns.shipped })).toBeInTheDocument();
    // The pending #13 request shows as an approval-needed card. In v5 the card carries only the ask line —
    // the Approve / Not yet pair lives in the drawer (you dive in to decide), so there's no inline button.
    // (The same item also appears as a standup row — board + standup are two groupings of one item.)
    const waitingLane = screen.getByRole("listitem", { name: CONSOLE.columns.waiting });
    expect(await within(waitingLane).findByText("Send launch email sequence")).toBeInTheDocument();
    expect(within(waitingLane).queryByRole("button", { name: CONSOLE.peek.approve })).toBeNull();
  });

  it("carries the spend gauge, fleet-health, and the waiting chip in the header", async () => {
    await mount();
    expect(await screen.findByText(CONSOLE.gauge.onTrack)).toBeInTheDocument(); // 6.1% utilization
    expect(screen.getByText(CONSOLE.health.healthy)).toBeInTheDocument();
    // "1 waiting on you" chip (hidden at zero).
    expect(screen.getByRole("button", { name: /1 waiting on you/ })).toBeInTheDocument();
  });

  it("turns the fleet-health signal red WITH the reason when self-healing escalates (#193 AC3)", async () => {
    await mount({
      fc: fcDto({
        attention: {
          required: true,
          reasons: ["2 self-healing incidents escalated (auto-remediation could not close)"],
        },
      }),
    });
    expect(await screen.findByText(CONSOLE.health.attention)).toBeInTheDocument();
    expect(
      screen.getByText(/self-healing incidents escalated/, { exact: false }),
    ).toBeInTheDocument();
  });

  it("shows the approvals-clear moment when nothing is waiting", async () => {
    await mount({ pending: [] });
    expect(await screen.findByText(CONSOLE.approvalsClear.headline)).toBeInTheDocument();
    // The chip disappears at zero.
    expect(screen.queryByRole("button", { name: /waiting on you/ })).toBeNull();
  });

  it("peeks a running session open into the transcript drawer", async () => {
    await mount();
    const running = await screen.findByText(CONSOLE.columns.running);
    const lane = running.closest(".board__col")!;
    const card = within(lane as HTMLElement).getAllByRole("article")[0]!;
    await userEvent.click(card);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("approves through the real #13 gate (store.decideApprove) from the drawer, not a shortcut", async () => {
    const utils = await mount();
    const spy = vi.spyOn(utils.store, "decideApprove");
    // Dive into the approval-needed task from its board card, then Approve inside the drawer.
    const waitingLane = await screen.findByRole("listitem", { name: CONSOLE.columns.waiting });
    const card = within(waitingLane).getByText("Send launch email sequence").closest("article")!;
    await userEvent.click(card);
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: CONSOLE.peek.approve }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("r1"));
  });

  it("walks a dead first-run workspace to a guided empty-state with a start CTA (#213)", async () => {
    // A fresh workspace: no venture, no live sessions, nothing pending → instead of a 0/0/0 dead board
    // the console shows the first-run activation panel.
    await mount({ mc: mcDto({ sessions: [], count: 0, totalEstimatedCostCents: 0 }), pending: [], fc: firstRunFc() });
    expect(await screen.findByText(CONSOLE.firstRun.headline)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: CONSOLE.firstRun.cta })).toBeInTheDocument();
    // The board lanes are NOT rendered while empty (the empty-state replaces them).
    expect(screen.queryByRole("listitem", { name: CONSOLE.columns.running })).toBeNull();
    // The left-rail control is present too (the always-available affordance).
    expect(
      screen.getByRole("button", { name: new RegExp(CONSOLE.projects.startTitle) }),
    ).toBeInTheDocument();
  });

  it("starts a venture through the REAL #123/#138 department seed, not a fake (#213)", async () => {
    const seedSpy = vi
      .spyOn(api.department, "seed")
      .mockResolvedValue({ channels: [], agents: [], welcomeTasks: [] });
    await mount({ mc: mcDto({ sessions: [], count: 0, totalEstimatedCostCents: 0 }), pending: [], fc: firstRunFc() });

    await userEvent.click(await screen.findByRole("button", { name: CONSOLE.firstRun.cta }));

    // The seed seam is hit with welcomeTasks so each lead launches its first real session.
    await waitFor(() =>
      expect(seedSpy).toHaveBeenCalledWith("w1", { welcomeTasks: true }),
    );
    // Until the new sessions surface on the next poll, the panel confirms the team is clocking in.
    expect(await screen.findByText(CONSOLE.firstRun.assembling)).toBeInTheDocument();
  });

  it("surfaces a quiet retry line when the seed seam fails (#213)", async () => {
    vi.spyOn(api.department, "seed").mockRejectedValue(new Error("boom"));
    await mount({ mc: mcDto({ sessions: [], count: 0, totalEstimatedCostCents: 0 }), pending: [], fc: firstRunFc() });
    await userEvent.click(await screen.findByRole("button", { name: CONSOLE.firstRun.cta }));
    expect(await screen.findByText(CONSOLE.firstRun.ctaError)).toBeInTheDocument();
  });

  it("surfaces an actionable rate-limit countdown and HOLDS the retry when the seed is 429'd (#221)", async () => {
    // The dead-end bug: a 429 re-fired the same request straight back into the limit. Now the panel shows
    // an honest "retry in Ns" from the server's Retry-After and disables the CTA until it elapses.
    vi.spyOn(api.department, "seed").mockRejectedValue(
      new ApiError("launch denied: tenant_capacity", 429, 7),
    );
    await mount({ mc: mcDto({ sessions: [], count: 0, totalEstimatedCostCents: 0 }), pending: [], fc: firstRunFc() });
    await userEvent.click(await screen.findByRole("button", { name: CONSOLE.firstRun.cta }));

    // The countdown line is shown (seeded from Retry-After), and the CTA is held — it cannot re-hit the cap.
    expect(await screen.findByText(/You can try again in/)).toBeInTheDocument();
    const held = screen.getByRole("button", { name: CONSOLE.firstRun.retryWait });
    expect(held).toBeDisabled();
    // The generic dead-end retry copy is NOT shown — the message is specific and actionable.
    expect(screen.queryByText(CONSOLE.firstRun.ctaError)).toBeNull();
  });

  it("routes a runtime-less / unreachable seed failure to Connect Claude (#221)", async () => {
    // When the team can't run for lack of a connected runtime, the real next step is to connect one —
    // a settings route, not a retry. (API_UNAVAILABLE / non-429 ApiError classifies as the connect path.)
    vi.spyOn(api.department, "seed").mockRejectedValue(new ApiError("API not connected", 0));
    await mount({ mc: mcDto({ sessions: [], count: 0, totalEstimatedCostCents: 0 }), pending: [], fc: firstRunFc() });
    await userEvent.click(await screen.findByRole("button", { name: CONSOLE.firstRun.cta }));

    expect(await screen.findByText(CONSOLE.firstRun.connectError)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: CONSOLE.firstRun.connectErrorCta })).toBeInTheDocument();
  });

  it("renders the venture's departments — NOT the empty desk — when activated with zero live sessions (#226)", async () => {
    // The dogfooded prod bug: `venturePipeline.total ≥ 1` but no welcome session ever spawned (mission
    // control empty), and the console STILL rendered the empty desk across a full reload. The empty desk is
    // now driven strictly off "the workspace has a venture", so an activated workspace always renders its
    // departments — created-but-paused — instead of "Start your first venture".
    const seo: Channel = { id: "c-seo", workspaceId: "w1", kind: "public", name: "seo", isArchived: false };
    mockDepartment(); // the #301 auto-run fires on this fresh-but-ready board; stub its seams.
    await mount(
      {
        mc: mcDto({ sessions: [], count: 0, totalEstimatedCostCents: 0 }),
        pending: [],
        fc: fcDto({ venturePipeline: { total: 1, active: 1, funded: 0, killed: 0, escalated: 0 } }),
      },
      { channels: [seo] },
    );
    // NOT on the empty desk…
    expect(await screen.findByRole("listitem", { name: CONSOLE.columns.running })).toBeInTheDocument();
    expect(screen.queryByText(CONSOLE.firstRun.headline)).toBeNull();
    expect(screen.queryByRole("button", { name: CONSOLE.firstRun.cta })).toBeNull();
    // …and the seo department renders as a project lane despite zero live work (the venture, paused).
    expect(screen.getByText("seo")).toBeInTheDocument();
  });

  it("NEVER renders raw runner / exit-code errors — degrades to the calm warming-up state (#299)", async () => {
    // #299: a fresh #seo workspace used to surface the server's raw failure copy + exit-code chips
    // ("model isn't available — model · exit 1", "stopped before I finished — canceled · exit n/a"). The
    // root cause is owner-gated prod (#292/#293); the UI must degrade gracefully. With a sessions_failing
    // diagnostic the console shows ONLY the branded warming-up panel and silently retries — no exit codes,
    // no internal failure-class names, no recent-failure list.
    mockDepartment(); // the silent auto-run retry fires while failing; stub its seams.
    await mount({
      mc: mcDto({
        sessions: [],
        count: 0,
        totalEstimatedCostCents: 0,
        diagnostic: {
          state: "sessions_failing",
          headline: "The model this workspace is set to use isn't available",
          detail: "Pick a valid model in Settings → Model.",
          dominantFailureClass: "model",
          liveCount: 0,
          recentFailureCount: 2,
        },
        recentFailures: [
          {
            id: "s1",
            channelId: "c1",
            agentMemberId: "ag1",
            status: "failed",
            exitCode: 1,
            failureClass: "model",
            headline: "The model this workspace is set to use isn't available",
            detail: "configured model can't be reached",
            endedAtMs: 1_700_000_000_000,
          },
        ],
      }),
      pending: [],
      fc: fcDto({ venturePipeline: { total: 1, active: 1, funded: 1, killed: 0, escalated: 0 } }),
    });

    // The calm branded state is shown…
    expect(await screen.findByText(CONSOLE.warmingUp.headline)).toBeInTheDocument();
    // …and NONE of the raw runner/exit/model copy leaks (the #299 acceptance criteria, verbatim).
    expect(screen.queryByText(/exit 1/)).toBeNull();
    expect(screen.queryByText(/exit n\/a/i)).toBeNull();
    expect(screen.queryByText(/isn't available/i)).toBeNull();
    expect(screen.queryByText(/model · exit/i)).toBeNull();
    expect(screen.queryByText(/spawn · exit/i)).toBeNull();
  });

  it("auto-runs ONE safe first-run deliverable (Scout audits the site) with zero setup (#301)", async () => {
    // #301: a fresh-but-ready board (a venture, departments, nothing running) is a dead empty board. The
    // console auto-briefs Scout on a safe, no-spend site audit so value appears with zero clicks.
    const briefSpy = mockDepartment();
    const seo: Channel = { id: "c-seo", workspaceId: "w1", kind: "public", name: "seo", isArchived: false };
    await mount(
      {
        mc: mcDto({ sessions: [], count: 0, totalEstimatedCostCents: 0 }),
        pending: [],
        fc: fcDto({ venturePipeline: { total: 1, active: 1, funded: 1, killed: 0, escalated: 0 } }),
      },
      { channels: [seo] },
    );

    // Scout is briefed on the safe audit goal, no owner action required.
    await waitFor(() =>
      expect(briefSpy).toHaveBeenCalledWith("w1", { lead: CONSOLE.firstRun.autoLead, goal: CONSOLE.firstRun.autoGoal }),
    );
  });

  it("does NOT auto-run on the no-venture empty-state pitch (#301)", async () => {
    // The guided #213 activation pitch owns the no-venture case — the auto-run must stay out of it.
    const briefSpy = mockDepartment();
    await mount({ mc: mcDto({ sessions: [], count: 0, totalEstimatedCostCents: 0 }), pending: [], fc: firstRunFc() });
    expect(await screen.findByText(CONSOLE.firstRun.headline)).toBeInTheDocument();
    expect(briefSpy).not.toHaveBeenCalled();
  });

  it("hard-holds EVERY seed control during the rate-limit cool-off — a blocked click can't re-fire (#227)", async () => {
    // The dogfooded trap: a held click still re-fired into the limit (often via the always-present left-rail
    // control) and reset the window, locking the user out for minutes. Now the one authoritative hold
    // disables every seed entry point, and a guard means a blocked click never even sends a request.
    const seedSpy = vi
      .spyOn(api.department, "seed")
      .mockRejectedValue(new ApiError("launch denied: tenant_capacity", 429, 30));
    await mount({ mc: mcDto({ sessions: [], count: 0, totalEstimatedCostCents: 0 }), pending: [], fc: firstRunFc() });

    // One click fires once and trips the limit.
    await userEvent.click(await screen.findByRole("button", { name: CONSOLE.firstRun.cta }));
    await screen.findByText(/You can try again in/);
    expect(seedSpy).toHaveBeenCalledTimes(1);

    // The always-present left-rail "Start a venture" control is disabled too (not just the empty-state CTA),
    // so a second click anywhere cannot re-fire and reset the window.
    const railStart = screen.getByRole("button", { name: CONSOLE.projects.start });
    expect(railStart).toBeDisabled();
    await userEvent.click(railStart);
    expect(seedSpy).toHaveBeenCalledTimes(1); // still once — the hold blocked the re-fire
  });

  it("carries the in-header Upgrade CTA that opens the pricing overlay (#215)", async () => {
    vi.spyOn(api.billing, "listPlans").mockResolvedValue({ current: null, plans: [] });
    await mount();
    const upgrade = await screen.findByRole("button", { name: CONSOLE.gauge.upgrade });
    await userEvent.click(upgrade);
    // The pricing overlay (a shell dialog) opens so a trial user can convert without hitting a cap first.
    expect(
      await screen.findByRole("dialog", { name: CONSOLE.shell.settingsTitle }),
    ).toBeInTheDocument();
  });

  it("confirms the upgrade and strips the flag when returning from checkout (#215)", async () => {
    window.history.replaceState(null, "", "/?checkout=success");
    await mount();
    // The success banner shows on return, and the query flag is removed so a reload won't re-fire it.
    expect(await screen.findByText(CONSOLE.checkoutReturn.success)).toBeInTheDocument();
    expect(window.location.search).not.toContain("checkout");
  });

  it("opens the per-project settings sheet from the standup gear", async () => {
    await mount();
    const gears = await screen.findAllByRole("button", { name: new RegExp(`^${CONSOLE.projects.settings}`) });
    await userEvent.click(gears[0]!);
    // The sheet's dialog becomes accessible (closed dialogs are aria-hidden, so this is unambiguous).
    expect(await screen.findByRole("dialog", { name: new RegExp(CONSOLE.projects.settings) })).toBeInTheDocument();
    expect(screen.getByText(CONSOLE.settings.tabs.models)).toBeInTheDocument();
  });
});
