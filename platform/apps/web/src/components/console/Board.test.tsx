/**
 * Board (#248): a running card carries a Stop control so the owner can kill a runaway agent without
 * leaving the board. The control raises the `onStop` intent (the real cancel happens in ConsoleView →
 * the mission-control stop endpoint); clicking it must NOT also open the drawer (stopPropagation).
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Board } from "./Board.js";
import { CONSOLE } from "../../brand.js";
import type { ConsoleItem, ItemKind } from "./model.js";

const runningItem: ConsoleItem = {
  key: "sess-stuck-1",
  kind: "running",
  agentLabel: "Scout",
  hue: undefined,
  channelId: "c1",
  channelName: "seo",
  title: "Scout · #seo",
  meta: "running",
  elapsedMs: 1_800_000,
  costCents: 120,
};

const cols = (over: Partial<Record<ItemKind, ConsoleItem[]>> = {}): Record<ItemKind, readonly ConsoleItem[]> => ({
  running: [],
  waiting: [],
  shipped: [],
  ...over,
});

describe("Board — Stop control on a running card (#248)", () => {
  it("renders a Stop button on the running card and raises onStop with the session item", async () => {
    const onStop = vi.fn();
    const onPeek = vi.fn();
    render(
      <Board columns={cols({ running: [runningItem] })} onPeek={onPeek} onWhy={vi.fn()} onStop={onStop} />,
    );
    const stop = screen.getByRole("button", { name: `${CONSOLE.card.stop} Scout` });
    await userEvent.click(stop);
    expect(onStop).toHaveBeenCalledWith(runningItem);
    // Stopping must NOT also open the drawer (the card's onClick is suppressed).
    expect(onPeek).not.toHaveBeenCalled();
  });

  it("renders no Stop control when onStop is not provided (back-compat)", () => {
    render(<Board columns={cols({ running: [runningItem] })} onPeek={vi.fn()} onWhy={vi.fn()} />);
    expect(screen.queryByRole("button", { name: new RegExp(CONSOLE.card.stop) })).toBeNull();
  });
});

describe("Board — deliverable cards are human, never raw (#302)", () => {
  const waitingDeliverable: ConsoleItem = {
    key: "d1",
    kind: "waiting",
    agentLabel: "Scout",
    hue: undefined,
    channelId: "c1",
    channelName: "seo",
    title: "Audit the homepage for SEO",
    meta: CONSOLE.deliverable.review,
    requestId: "d1",
    actionType: "agent.deliverable",
    preview: "Found 3 quick wins",
    consequence: CONSOLE.deliverable.consequence,
  };

  it("shows the human title, preview, and consequence — no raw type id, no 'ready for review'", () => {
    render(<Board columns={cols({ waiting: [waitingDeliverable] })} onPeek={vi.fn()} onWhy={vi.fn()} />);
    expect(screen.getByText("Audit the homepage for SEO")).toBeInTheDocument();
    expect(screen.getByText("Found 3 quick wins")).toBeInTheDocument();
    expect(screen.getByText(new RegExp(CONSOLE.deliverable.consequence))).toBeInTheDocument();
    expect(screen.queryByText(/agent\.deliverable/)).toBeNull();
    expect(screen.queryByText(/ready for review/i)).toBeNull();
  });

  it("a Done deliverable shows its preview and the done status, not 'ready for review'", () => {
    const shipped: ConsoleItem = { ...waitingDeliverable, kind: "shipped", meta: CONSOLE.deliverable.shipped, consequence: undefined };
    render(<Board columns={cols({ shipped: [shipped] })} onPeek={vi.fn()} onWhy={vi.fn()} />);
    expect(screen.getByText("Audit the homepage for SEO")).toBeInTheDocument();
    expect(screen.getByText(CONSOLE.status.shipped)).toBeInTheDocument();
    expect(screen.queryByText(/ready for review/i)).toBeNull();
    expect(screen.queryByText(/agent\.deliverable/)).toBeNull();
  });
});
