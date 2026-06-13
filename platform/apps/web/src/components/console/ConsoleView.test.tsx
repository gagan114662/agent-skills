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
import { api } from "../../api/client.js";
import type { FounderConsoleDto, MissionControlDto } from "../../api/types.js";
import { CONSOLE } from "../../brand.js";
import { renderWithStore } from "../../test/utils.js";

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

afterEach(() => vi.restoreAllMocks());

async function mount(opts?: Parameters<typeof mockSeams>[0]) {
  mockSeams(opts);
  const utils = renderWithStore(<ConsoleView />);
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

  it("opens the per-project settings sheet from the standup gear", async () => {
    await mount();
    const gears = await screen.findAllByRole("button", { name: new RegExp(`^${CONSOLE.projects.settings}`) });
    await userEvent.click(gears[0]!);
    // The sheet's dialog becomes accessible (closed dialogs are aria-hidden, so this is unambiguous).
    expect(await screen.findByRole("dialog", { name: new RegExp(CONSOLE.projects.settings) })).toBeInTheDocument();
    expect(screen.getByText(CONSOLE.settings.tabs.models)).toBeInTheDocument();
  });
});
