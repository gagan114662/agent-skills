/**
 * Stacked-top-banner layout guard (#503) — on the reload.chat surface the #487 runtime-failure banner ("I
 * couldn't start up…") and the #479 first-run checklist used to stack as full-height flow siblings ABOVE the
 * channel. Together they consumed roughly the top half of the screen, pushing the channel header + latest
 * messages below the fold on first paint: the first impression was chrome, not conversation.
 *
 * The fix puts both banners inside ONE height-capped, scrollable rail (`.console__banners`) and makes the
 * error banner compact + dismissible. This guards the invariants that keep the channel above the fold:
 *   1. Both banners live inside the SINGLE `.console__banners` rail (never bare siblings of `.coord`).
 *   2. `.console__banners` is `flex: none` + `max-height: <vh>` + `overflow-y: auto` — so the stack can never
 *      consume more than a slice of the viewport, leaving the rest to `.coord` (flex: 1).
 *   3. The channel (`.coord`) renders AFTER the banner rail, so the conversation owns the space below it.
 *   4. The error banner is dismissible — dismissing it leaves the checklist and the channel in place.
 *
 * jsdom can't compute CSS layout, so the height-cap invariants (2) are asserted against the stylesheet source
 * directly — same approach as CoordinationView.layout.test.tsx / PricingTable.visibility.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { act, fireEvent, screen } from "@testing-library/react";
import type { FounderConsoleDto, MissionControlDto } from "../../api/types.js";
import { api } from "../../api/client.js";
import { CONSOLE } from "../../brand.js";
import { renderWithStore } from "../../test/utils.js";

const OWNER_WS = "w1";

// Flip the coordination gate ON for the test workspace (mirrors ConsoleView.coordination.test.tsx).
const gate = vi.hoisted(() => ({ flagOn: true, owner: "w1" as string | undefined }));
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

const { ConsoleView } = await import("./ConsoleView.js");

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "../../styles.css"), "utf8");
/** Extract the body of an exact top-level `<selector> {` rule (first match, never a `--mod`/`__el` variant). */
function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `the ${selector} rule must exist`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

const FAILING = {
  state: "sessions_failing" as const,
  headline: "I couldn't start up — my runtime is missing a tool I need.",
  detail: "The team's been pinged to patch the agent image — try again once it's redeployed.",
  dominantFailureClass: "spawn" as const,
  liveCount: 0,
  recentFailureCount: 3,
};

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

/** Mount the coordination surface of a FRESH workspace (so the first-run checklist shows) WITH a failing
 *  runtime diagnostic (so the error banner shows) — i.e. exactly the both-banners-stacked first paint. */
async function mountBothBanners() {
  // Fresh workspace seams: no connection / no agent ran ⇒ FirstRunChecklist is shown.
  vi.spyOn(api, "getFounderConsole").mockResolvedValue(fcDto());
  vi.spyOn(api.approvals, "list").mockResolvedValue([]);
  vi.spyOn(api.department, "seed").mockResolvedValue({ channels: [], agents: [], welcomeTasks: [] });
  vi.spyOn(api.department, "brief").mockResolvedValue({
    lead: "scout",
    department: "seo",
    channelId: "c-seo",
    messageId: "m1",
    launched: [],
    connectPrompted: [],
  });
  // …and the failing diagnostic ⇒ the runtime-error banner is shown.
  vi.spyOn(api.missionControl, "get").mockResolvedValue({ ...mcDto(), diagnostic: FAILING });

  const utils = renderWithStore(<ConsoleView />);
  await act(async () => {
    await utils.store.bootstrap();
  });
  return utils;
}

const COORD_LABEL = CONSOLE.coordination.title;
const CHECKLIST_LABEL = CONSOLE.firstRunChecklist.title;
const DISMISS_LABEL = CONSOLE.coordination.diagnostic.dismissLabel;

beforeEach(() => {
  gate.flagOn = true;
  gate.owner = OWNER_WS;
});
afterEach(() => vi.restoreAllMocks());

describe("ConsoleView stacked top banners stay above the fold (#503)", () => {
  it(".console__banners is a height-capped, scrollable, flex:none rail (the stack can't eat the viewport)", () => {
    const body = ruleBody(".console__banners");
    // flex: none keeps the rail OUT of the column's grow/shrink fight — it never grows past its content.
    expect(body, ".console__banners must be flex: none").toMatch(/flex\s*:\s*none/);
    // A viewport-relative cap means however tall the banners get, the channel below keeps the majority.
    const cap = body.match(/max-height\s*:\s*(\d+)vh/);
    expect(cap, ".console__banners must cap its height in vh").not.toBeNull();
    expect(Number(cap![1]), "the banner stack must be capped to less than half the viewport").toBeLessThanOrEqual(50);
    // …and it scrolls internally rather than pushing siblings down when the content exceeds the cap.
    expect(body, ".console__banners must scroll internally past the cap").toMatch(/overflow-y\s*:\s*auto/);
  });

  it(".coord still claims the remaining space (flex: 1) so the channel fills below the banners", () => {
    // The channel surface is built to fill leftover column space; with the banners capped, that is the
    // majority of the viewport. (Pinned here so a future banner change can't quietly steal the channel.)
    expect(ruleBody(".coord"), ".coord must grow to fill the space the capped banner rail leaves").toMatch(
      /flex\s*:\s*1/,
    );
  });

  it("with BOTH banners shown, they share the single rail and the channel renders after it", async () => {
    const { container } = await mountBothBanners();

    // Both banners are present on first paint…
    expect(await screen.findByText(/couldn't start up/i)).toBeInTheDocument();
    expect(screen.getByLabelText(COORD_LABEL)).toBeInTheDocument();
    expect(screen.getByLabelText(CHECKLIST_LABEL)).toBeInTheDocument();

    // …both live inside the ONE capped rail (never bare siblings of the channel)…
    const rail = container.querySelector(".console__banners");
    expect(rail, "the banner rail must be mounted").not.toBeNull();
    expect(rail!.querySelector(".consolediag--sessions_failing"), "error banner is in the rail").not.toBeNull();
    expect(rail!.querySelector(".firstrun"), "first-run checklist is in the rail").not.toBeNull();

    // …and the channel (`.coord`) is a sibling that follows the rail in DOM order, so the conversation owns
    // the space below the banners instead of being pushed off-screen.
    const coord = container.querySelector(".coord");
    expect(coord, "the channel surface must be mounted").not.toBeNull();
    expect(rail!.contains(coord), "the channel must NOT be nested inside the banner rail").toBe(false);
    expect(
      rail!.compareDocumentPosition(coord!) & Node.DOCUMENT_POSITION_FOLLOWING,
      "the channel must come AFTER the banner rail",
    ).toBeTruthy();
  });

  it("the runtime-error banner is dismissible; dismissing it keeps the checklist and the channel", async () => {
    const { container } = await mountBothBanners();

    await screen.findByText(/couldn't start up/i);
    const dismiss = screen.getByRole("button", { name: DISMISS_LABEL });

    await act(async () => {
      fireEvent.click(dismiss);
    });

    // The error banner is gone…
    expect(screen.queryByText(/couldn't start up/i)).toBeNull();
    expect(container.querySelector(".consolediag--sessions_failing")).toBeNull();
    // …but the checklist and the channel remain (dismiss is compact, not a surface reset).
    expect(screen.getByLabelText(CHECKLIST_LABEL)).toBeInTheDocument();
    expect(container.querySelector(".coord")).not.toBeNull();
  });
});
