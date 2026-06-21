/**
 * Reload.chat as the whole app for the owner workspace (#378). Proves the final parity step: when the
 * coordination gate (#352) is on for the named owner workspace, the reload.chat surface IS the entire app —
 * the owner lands in `CoordinationView`, and the kanban board, the Coordination/Board toggle, and the
 * projects/task sidebar (StandupPanel) are all gone from the rendered surface. When the gate is OFF or this
 * is NOT the owner, the surface is byte-for-byte the board it is today (fail-closed, owner-first, default-OFF).
 *
 * The two env-derived constants (`COORDINATION_UI_ENABLED` / `COORDINATION_OWNER_WORKSPACE_ID`) are mocked
 * via a hoisted holder so each case can flip the gate; the REAL `shouldShowCoordination` is kept, so the
 * owner-first contract itself is exercised (owner id == the test workspace ⇒ on; a different owner ⇒ off).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import type { FounderConsoleDto, MissionControlDto } from "../../api/types.js";
import type { ApprovalRequestDto } from "@reload/shared";
import { api } from "../../api/client.js";
import { CONSOLE, consoleRunningPill, consoleWaitingChip } from "../../brand.js";
import { renderWithStore } from "../../test/utils.js";

// The test identity's workspace (utils.TEST_IDENTITY) — naming THIS workspace as the owner turns the gate on.
const OWNER_WS = "w1";

// Mutable gate inputs, hoisted so the module mock below can read them lazily (per render, per test). The
// owner literal is inlined here because `vi.hoisted` runs before module-level `const`s are initialized.
const gate = vi.hoisted(() => ({ flagOn: true, owner: "w1" as string | undefined }));

// Mock ONLY the two env-derived constants; keep the real `shouldShowCoordination` so the owner-first gate is
// genuinely exercised. Getters mean a test can flip `gate.*` before mounting and the next render sees it.
vi.mock("./coordination-flag.js", async (orig) => {
  const actual = await orig<typeof import("./coordination-flag.js")>();
  return {
    ...actual,
    get COORDINATION_UI_ENABLED() {
      return gate.flagOn;
    },
    get COORDINATION_OWNER_WORKSPACE_ID() {
      return gate.owner;
    },
  };
});

// Imported AFTER the mock is declared so ConsoleView binds the mocked flag module.
const { ConsoleView } = await import("./ConsoleView.js");

const mcDto = (): MissionControlDto => ({
  sessions: [],
  count: 0,
  totalEstimatedCostCents: 0,
  rateCentsPerMinute: 0,
  costIsEstimate: true,
});

const fcDto = (): FounderConsoleDto => ({
  workspaceId: OWNER_WS,
  generatedAtMs: 1_700_000_000_000,
  fleet: { activeSessions: 0, sessionsThisWindow: 0, globalInFlight: 0 },
  venturePipeline: { total: 2, active: 1, funded: 1, killed: 0, escalated: 0 },
  revenue: { currency: "usd", totalCents: 0, paymentCount: 0, willingnessToPayCount: 0, hasWillingnessToPay: false },
  budget: { window: "2026-06", estimatedCostCents: 0, budgetCents: 100000, overBudget: false, utilization: 0 },
  pendingApprovals: [],
  switches: { killSwitch: false, maintenance: { enabled: false } },
  attention: { required: false, reasons: [] },
});

function mockSeams(): void {
  vi.spyOn(api.missionControl, "get").mockResolvedValue(mcDto());
  vi.spyOn(api, "getFounderConsole").mockResolvedValue(fcDto());
  vi.spyOn(api.approvals, "list").mockResolvedValue([]);
  // The #301 first-run auto-run can fire on this ready board; stub its seams so nothing hits a real fetch.
  vi.spyOn(api.department, "seed").mockResolvedValue({ channels: [], agents: [], welcomeTasks: [] });
  vi.spyOn(api.department, "brief").mockResolvedValue({
    lead: "scout",
    department: "seo",
    channelId: "c-seo",
    messageId: "m1",
    launched: [],
    connectPrompted: [],
  });
}

async function mount() {
  mockSeams();
  const utils = renderWithStore(<ConsoleView />);
  await act(async () => {
    await utils.store.bootstrap();
  });
  return utils;
}

/** The coordination region's accessible label — present iff the coordination surface is mounted. #384 removed
 *  the visible "Team coordination" heading, but the string survives as the region's `aria-label`. */
const COORD_LABEL = CONSOLE.coordination.title;
/** Any board lane — present iff the board surface is mounted. */
const BOARD_LANE = { name: CONSOLE.columns.running } as const;

beforeEach(() => {
  gate.flagOn = true;
  gate.owner = OWNER_WS;
});
afterEach(() => vi.restoreAllMocks());

describe("ConsoleView reload.chat whole-app surface (#378)", () => {
  it("owner + flag ON ⇒ coordination IS the whole app (no board, no toggle, no projects sidebar)", async () => {
    await mount();

    // The owner lands directly in the coordination view (the team channel is the home screen)…
    expect(await screen.findByLabelText(COORD_LABEL)).toBeInTheDocument();
    // …the kanban board is gone entirely (no lanes anywhere)…
    expect(screen.queryByRole("listitem", BOARD_LANE)).toBeNull();
    // …the Coordination/Board toggle is removed…
    expect(screen.queryByRole("tab", { name: CONSOLE.coordination.open })).toBeNull();
    expect(screen.queryByRole("tab", { name: CONSOLE.columns.shipped })).toBeNull();
    // …and the projects/task sidebar (StandupPanel) is not rendered.
    expect(screen.queryByText(CONSOLE.projects.label)).toBeNull();

    // Approvals stay reachable and account utilities move into the header.
    expect(screen.getByRole("button", { name: CONSOLE.coordination.shell.settings })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: CONSOLE.coordination.shell.signOut })).toBeInTheDocument();
  });

  // #381: the coordination landing must be CLEAN — the per-project settings sheet (and the peek drawer) are
  // board-only surfaces with no trigger here, so they must not be mounted over the chat at all. The live bug
  // showed a stray settings/project overlay auto-open on landing; this pins the element out of the DOM.
  it("owner + flag ON ⇒ no stray project-settings / peek overlay is mounted on the coordination landing", async () => {
    const { container } = await mount();

    await screen.findByLabelText(COORD_LABEL);
    // The fixed full-screen overlays that belong to the board (project settings sheet, peek drawer) are not
    // rendered on the chat-first landing — they can only be opened from board affordances that aren't here.
    expect(container.querySelector(".sheet"), "the project-settings sheet must not be mounted here").toBeNull();
    expect(container.querySelector(".peek"), "the peek drawer must not be mounted here").toBeNull();
  });

  it("flag OFF ⇒ the board surface still mounts its project-settings sheet (closed, board-only)", async () => {
    gate.flagOn = false;
    const { container } = await mount();

    // On the board, the sheet exists (closed) so a project row can open it — coordination removal is scoped.
    await screen.findByRole("listitem", BOARD_LANE);
    expect(container.querySelector(".sheet"), "the board keeps its (closed) project-settings sheet").not.toBeNull();
  });

  it("flag OFF ⇒ board is the landing surface, byte-for-byte (board + projects sidebar, no coordination)", async () => {
    gate.flagOn = false;
    await mount();

    // The board lanes + the projects sidebar render as the landing surface…
    expect(await screen.findByRole("listitem", BOARD_LANE)).toBeInTheDocument();
    expect(screen.getByText(CONSOLE.projects.label)).toBeInTheDocument();
    // …and the coordination surface is absent entirely.
    expect(screen.queryByLabelText(COORD_LABEL)).toBeNull();
  });

  it("non-owner workspace + flag ON ⇒ board unchanged (owner-first, fail-closed)", async () => {
    gate.owner = "ws_someone_else"; // a named owner that is NOT this workspace → the real gate returns false
    await mount();

    expect(await screen.findByRole("listitem", BOARD_LANE)).toBeInTheDocument();
    expect(screen.getByText(CONSOLE.projects.label)).toBeInTheDocument();
    expect(screen.queryByLabelText(COORD_LABEL)).toBeNull();
  });
});

// #384: the reload.chat top bar is slim — channel name + a small "N running" pill + an unobtrusive
// "N waiting on you" chip + gear/sign-out. The budget gauge, the Upgrade button, and the fleet-health
// banner do NOT sit over the chat (they live in Settings → Billing). The board (gate OFF) keeps them.
describe("ConsoleView slim reload.chat header (#384)", () => {
  it("owner + flag ON ⇒ the budget gauge / Upgrade / fleet-health banner are NOT in the header", async () => {
    const { container } = await mount();

    await screen.findByLabelText(COORD_LABEL);
    expect(container.querySelector(".gauge"), "no budget banner over the chat").toBeNull();
    expect(container.querySelector(".gauge-upgrade"), "no Upgrade button over the chat").toBeNull();
    expect(container.querySelector(".fleet-health"), "no fleet-health banner over the chat").toBeNull();
    // The gear (Settings) — where budget/Upgrade now live — stays reachable.
    expect(screen.getByRole("button", { name: CONSOLE.coordination.shell.settings })).toBeInTheDocument();
  });

  it("owner + flag ON + running sessions ⇒ a small 'N running' pill (not a table) shows in the header", async () => {
    mockSeams();
    // Two live sessions — the poll resolves to them on the immediate tick.
    vi.spyOn(api.missionControl, "get").mockResolvedValue({
      ...mcDto(),
      count: 2,
      sessions: [
        { id: "s1", channelId: "c-seo", agentMemberId: "ag1", status: "running", elapsedMs: 1000, estimatedCostCents: 0, startedAt: null, progressAt: "2026-06-19T00:00:00Z" },
        { id: "s2", channelId: "c-seo", agentMemberId: "ag1", status: "running", elapsedMs: 2000, estimatedCostCents: 0, startedAt: null, progressAt: "2026-06-19T00:00:00Z" },
      ],
    });
    const utils = renderWithStore(<ConsoleView />);
    await act(async () => {
      await utils.store.bootstrap();
    });

    // The calm pill, never the old sessions table.
    expect(await screen.findByText(consoleRunningPill(2))).toBeInTheDocument();
    expect(utils.container.querySelector(".runpill")).not.toBeNull();
    expect(utils.container.querySelector(".mission__table"), "no mission-control table above the feed").toBeNull();
  });

  it("flag OFF ⇒ the board keeps its budget gauge + Upgrade button (byte-for-byte)", async () => {
    gate.flagOn = false;
    const { container } = await mount();

    await screen.findByRole("listitem", BOARD_LANE);
    expect(container.querySelector(".gauge"), "the board keeps its budget gauge").not.toBeNull();
    expect(container.querySelector(".gauge-upgrade"), "the board keeps its Upgrade button").not.toBeNull();
  });
});

// #472: the "waiting on you" pill on the reload.chat surface must open a FIRST-CLASS approvals inbox
// (Approve/Reject per pending action, showing what will publish/send/spend) — not scroll to a plain agent
// message. Before, it dove into a board transcript that isn't even mounted on the coordination surface.
describe("ConsoleView coordination approvals inbox (#472)", () => {
  const pendingReq: ApprovalRequestDto = {
    id: "r1",
    workspaceId: OWNER_WS,
    requesterMemberId: "ag1",
    actionType: "external.send",
    payload: {},
    amount: null,
    summary: "Publish the launch blog post",
    status: "pending",
    reason: null,
    decidedByMemberId: null,
    decidedAt: null,
    expiresAt: null,
    result: null,
    error: null,
    createdAt: "2026-06-20T00:00:00Z",
    updatedAt: "2026-06-20T00:00:00Z",
  };

  it("owner + flag ON ⇒ the 'waiting on you' pill opens the Approvals inbox with the pending action", async () => {
    mockSeams();
    vi.spyOn(api.approvals, "list").mockImplementation(async (_w, status) =>
      status === "pending" ? [pendingReq] : [],
    );
    vi.spyOn(api.approvals, "listPolicies").mockResolvedValue([]);
    const utils = renderWithStore(<ConsoleView />);
    await act(async () => {
      await utils.store.bootstrap();
    });

    // The pill is present (1 pending)…
    const pill = await screen.findByRole("button", { name: consoleWaitingChip(1) });
    await act(async () => {
      fireEvent.click(pill);
    });

    // …and clicking it opens the first-class Approvals inbox (the #13 governance surface with status tabs
    // and per-request Approve/Reject) — not a scroll to a plain agent message.
    expect(await screen.findByRole("region", { name: /approvals/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /pending/i })).toBeInTheDocument();
  });
});

// #473: on the coordination surface the top-left header title was bound to `activeProjectId` (the board's
// column selection, which the chat sidebar never touches), so it showed a stale #content/#seo while the feed
// showed the real channel. The header must track the OPEN CHANNEL — what MessagePane renders — at all times.
describe("ConsoleView coordination header tracks the open channel (#473)", () => {
  it("owner + flag ON ⇒ the top-left title follows the active channel, never a stale project", async () => {
    const utils = await mount();
    await screen.findByLabelText(COORD_LABEL);
    const title = () => utils.container.querySelector(".console__title")?.textContent ?? "";

    await act(async () => {
      await utils.store.selectChannel("c2");
    });
    expect(title(), "header shows the open channel #random").toBe("#random");

    await act(async () => {
      await utils.store.selectChannel("c1");
    });
    expect(title(), "switching channel re-syncs the header to #general").toBe("#general");
  });
});
