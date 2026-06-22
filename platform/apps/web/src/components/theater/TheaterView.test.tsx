import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { TheaterView } from "./TheaterView.js";
import { renderWithStore } from "../../test/utils.js";

/**
 * Acceptance test for the live agent-theater (#624): a user opens one view and watches an agent produce
 * real output live — reasoning → action → artifact — over SSE. jsdom has no `EventSource`, so a global
 * fake stands in and we drive frames through it, then assert the streamed work renders as plain text.
 */

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  onerror: ((ev: unknown) => void) | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  private listeners = new Map<string, (ev: { data: string }) => void>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (ev: { data: string }) => void): void {
    this.listeners.set(type, listener);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(data) });
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
});
afterEach(() => {
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
  vi.restoreAllMocks();
});

const RUN = {
  id: "run-1",
  workspaceId: "w1",
  sessionId: null,
  agentMemberId: "ag1",
  taskId: null,
  label: "Mark",
  status: "open" as const,
  eventCount: 0,
  startedAt: "2026-06-22T00:00:00.000Z",
  endedAt: null,
};

describe("TheaterView (#624)", () => {
  it("shows the empty state before any agent is at work", async () => {
    const { store } = renderWithStore(<TheaterView />);
    await act(async () => {
      await store.bootstrap();
    });
    expect(screen.getByText(/No one's at work this second/i)).toBeInTheDocument();
  });

  it("streams an agent's reasoning → action → artifact live into a lane", async () => {
    const { store } = renderWithStore(<TheaterView />);
    await act(async () => {
      await store.bootstrap();
    });

    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const src = FakeEventSource.instances[0]!;
    // The stream targets the workspace fleet endpoint.
    expect(src.url).toContain("/workspaces/w1/traces/stream");

    act(() => src.onopen?.(null));
    act(() => src.emit("run", RUN));
    act(() =>
      src.emit("event", {
        id: "e1", runId: "run-1", seq: 1, turn: 0, type: "model_response",
        phase: "reasoning", label: "opus", summary: "I'll draft the launch post",
        occurredAt: "2026-06-22T00:00:01.000Z",
      }),
    );
    act(() =>
      src.emit("event", {
        id: "e2", runId: "run-1", seq: 2, turn: 0, type: "tool_call",
        phase: "action", label: "publish", summary: "publish blog post",
        occurredAt: "2026-06-22T00:00:02.000Z",
      }),
    );
    act(() =>
      src.emit("event", {
        id: "e3", runId: "run-1", seq: 3, turn: 0, type: "tool_result",
        phase: "artifact", label: "publish", summary: "https://ipop.ai/blog/launch",
        occurredAt: "2026-06-22T00:00:03.000Z",
      }),
    );

    // The lane appears with the agent name and the live work, rendered as plain text (content-as-data).
    await waitFor(() => expect(screen.getByText("Mark")).toBeInTheDocument());
    expect(screen.getByText("I'll draft the launch post")).toBeInTheDocument();
    expect(screen.getByText("publish blog post")).toBeInTheDocument();
    expect(screen.getByText("https://ipop.ai/blog/launch")).toBeInTheDocument();
    // Live status + the working chip.
    expect(screen.getByText(/Live/)).toBeInTheDocument();
    expect(screen.getByText(/Working/)).toBeInTheDocument();
  });

  it("flips a lane to Done when the run closes", async () => {
    const { store } = renderWithStore(<TheaterView />);
    await act(async () => {
      await store.bootstrap();
    });
    await waitFor(() => expect(FakeEventSource.instances.length).toBe(1));
    const src = FakeEventSource.instances[0]!;

    act(() => src.emit("run", RUN));
    act(() =>
      src.emit("event", {
        id: "e1", runId: "run-1", seq: 1, turn: 0, type: "tool_result",
        phase: "artifact", label: "ship", summary: "done",
        occurredAt: "2026-06-22T00:00:01.000Z",
      }),
    );
    act(() => src.emit("done", { runId: "run-1", eventCount: 1 }));

    await waitFor(() => expect(screen.getByText(/Done/)).toBeInTheDocument());
  });
});
