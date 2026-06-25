import { afterEach, describe, expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessagePane } from "./MessagePane.js";
import { CHANNEL_STARTERS, VOICE } from "../brand.js";
import { makeMessage, renderWithStore } from "../test/utils.js";
import type { EventSourceLike, TheaterEventDto, TheaterRunDto } from "../api/theater.js";

class FakeStepSource implements EventSourceLike {
  onerror: ((ev: unknown) => void) | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  closed = false;
  private listeners = new Map<string, (ev: { data: string }) => void>();

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

let currentStepSource: FakeStepSource | undefined;
const stepFactory = (): EventSourceLike => (currentStepSource = new FakeStepSource());

afterEach(() => {
  currentStepSource = undefined;
});

function traceRun(over: Partial<TheaterRunDto> & { id: string }): TheaterRunDto {
  return {
    workspaceId: "w1",
    sessionId: null,
    agentMemberId: null,
    taskId: null,
    label: null,
    status: "open",
    eventCount: 0,
    startedAt: "2026-06-24T00:00:00.000Z",
    endedAt: null,
    ...over,
  };
}

function traceEvent(over: Partial<TheaterEventDto> & { id: string; runId: string; seq: number }): TheaterEventDto {
  return {
    turn: 0,
    type: "model_response",
    phase: "reasoning",
    label: null,
    summary: "thinking through the brief",
    occurredAt: "2026-06-24T00:00:00.000Z",
    ...over,
  };
}

describe("MessagePane", () => {
  it("renders messages with resolved author names", async () => {
    const { store } = renderWithStore(<MessagePane />);
    await store.bootstrap();
    expect(await screen.findByText("first post")).toBeInTheDocument();
    expect(screen.getByText("Ada")).toBeInTheDocument();
  });

  it("bounds large channel histories to the latest messages in the DOM (#684)", async () => {
    const messages = Array.from({ length: 1_000 }, (_, i) =>
      makeMessage({ id: `m-${i}`, body: `history message ${i}` }),
    );
    const { store } = renderWithStore(<MessagePane />, { messages });
    await store.bootstrap();

    expect(await screen.findByText("history message 999")).toBeInTheDocument();
    expect(screen.queryByText("history message 0")).not.toBeInTheDocument();
    expect(screen.getByText("Showing latest 200 of 1000 messages")).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(200);
  });

  // #1051: while an agent is running in this channel, its trace steps stream into the work feed live.
  it("streams active agent trace steps into the open channel feed", async () => {
    const { store } = renderWithStore(<MessagePane stepEventSourceFactory={stepFactory} />);
    await store.bootstrap();
    await screen.findByText("first post");

    act(() => {
      store.setLiveSessions([
        { id: "sess-1", channelId: "c1", agentMemberId: "ag1", status: "running", agentStatus: "drafting" },
      ]);
    });
    await waitFor(() => expect(currentStepSource).toBeDefined());

    act(() => {
      currentStepSource!.emit("run", traceRun({ id: "run-1", sessionId: "sess-1", agentMemberId: "ag1" }));
      currentStepSource!.emit(
        "event",
        traceEvent({
          id: "step-1",
          runId: "run-1",
          seq: 1,
          phase: "action",
          label: "web_search",
          summary: "checking launch keywords",
        }),
      );
    });

    const steps = await screen.findByRole("list", { name: /live agent steps/i });
    expect(within(steps).getByText("Atlas")).toBeInTheDocument();
    expect(within(steps).getByText("action")).toBeInTheDocument();
    expect(within(steps).getByText("web_search")).toBeInTheDocument();
    expect(within(steps).getByText("checking launch keywords")).toBeInTheDocument();

    act(() => {
      currentStepSource!.emit("run", traceRun({ id: "run-2", sessionId: "sess-2", agentMemberId: "ag1" }));
      currentStepSource!.emit(
        "event",
        traceEvent({ id: "step-foreign", runId: "run-2", seq: 1, summary: "wrong channel step" }),
      );
    });
    expect(screen.queryByText("wrong channel step")).toBeNull();
  });

  it("keeps only a bounded tail of streamed agent steps in the channel feed", async () => {
    const { store } = renderWithStore(<MessagePane stepEventSourceFactory={stepFactory} />);
    await store.bootstrap();
    await screen.findByText("first post");

    act(() => {
      store.setLiveSessions([
        { id: "sess-1", channelId: "c1", agentMemberId: "ag1", status: "running", agentStatus: "drafting" },
      ]);
    });
    await waitFor(() => expect(currentStepSource).toBeDefined());

    act(() => {
      currentStepSource!.emit("run", traceRun({ id: "run-1", sessionId: "sess-1", agentMemberId: "ag1" }));
      for (let i = 1; i <= 25; i++) {
        currentStepSource!.emit(
          "event",
          traceEvent({ id: `step-${i}`, runId: "run-1", seq: i, summary: `bounded step ${i}` }),
        );
      }
    });

    const steps = await screen.findByRole("list", { name: /live agent steps/i });
    expect(within(steps).queryByText("bounded step 1")).toBeNull();
    expect(within(steps).getByText("bounded step 25")).toBeInTheDocument();
    expect(within(steps).getAllByRole("listitem")).toHaveLength(20);
  });

  // #480: a live session in THIS channel shows an in-channel "working…" indicator (not just the global pill).
  it("shows an in-channel 'working…' indicator for a live session in the open channel", async () => {
    const { store } = renderWithStore(<MessagePane />);
    await store.bootstrap();
    await screen.findByText("first post"); // channel c1 is open

    act(() => {
      store.setLiveSessions([{ id: "s1", channelId: "c1", agentMemberId: "ag1", status: "running", agentStatus: "drafting" }]);
    });
    expect(await screen.findByText("Atlas")).toBeInTheDocument();
    expect(screen.getByText("drafting")).toBeInTheDocument();

    // A session in a DIFFERENT channel does not show here.
    act(() => {
      store.setLiveSessions([{ id: "s2", channelId: "c2", agentMemberId: "ag1", status: "running", agentStatus: "drafting" }]);
    });
    await waitFor(() => expect(screen.queryByText("drafting")).toBeNull());
  });

  // #469: the user can cancel a run in-channel — the Stop button clears the indicator and calls the stop API.
  it("cancels a running session from the in-channel Stop button", async () => {
    const { store } = renderWithStore(<MessagePane />);
    await store.bootstrap();
    await screen.findByText("first post");

    act(() => {
      store.setLiveSessions([{ id: "s1", channelId: "c1", agentMemberId: "ag1", status: "running", agentStatus: "thinking" }]);
    });
    const stop = await screen.findByRole("button", { name: /stop this run/i });
    await userEvent.click(stop);

    // The indicator clears optimistically and the session is no longer live.
    await waitFor(() => expect(screen.queryByText("thinking")).toBeNull());
    expect(store.getState().liveSessions).toEqual([]);
  });

  it("marks agent authors with an AGENT badge (agent-first)", async () => {
    const { store } = renderWithStore(<MessagePane />, {
      messages: [makeMessage({ id: "m1", authorMemberId: "ag1", body: "deployed v2" })],
    });
    await store.bootstrap();

    expect(await screen.findByText("Atlas")).toBeInTheDocument();
    expect(screen.getByText("AGENT")).toBeInTheDocument();
  });

  it("appends a realtime message without a refresh", async () => {
    const { store, rt } = renderWithStore(<MessagePane />);
    await store.bootstrap();
    await screen.findByText("first post");

    rt.fire({ type: "message", message: makeMessage({ id: "m2", channelId: "c1", body: "live update" }) });

    await waitFor(() => expect(screen.getByText("live update")).toBeInTheDocument());
  });

  // #419: a reader pinned to the bottom auto-follows a new agent message — no pill, the message is just there.
  it("auto-follows a new message when the reader is at the bottom (no pill)", async () => {
    const { store, rt } = renderWithStore(<MessagePane />);
    await store.bootstrap();
    await screen.findByText("first post");

    await act(async () => {
      rt.fire({ type: "message", message: makeMessage({ id: "m2", authorMemberId: "ag1", body: "agent reply" }) });
    });

    await waitFor(() => expect(screen.getByText("agent reply")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /new message/i })).not.toBeInTheDocument();
  });

  // #419: a reader who scrolled UP into history is NOT yanked down — a "new messages" pill appears instead, and
  // clicking it jumps to the newest message and clears the pill. This is the perception fix for "looks dead".
  it("shows a 'new messages' pill when a message arrives while scrolled up, and clears it on click", async () => {
    const { store, rt, container } = renderWithStore(<MessagePane />);
    await store.bootstrap();
    await screen.findByText("first post");

    // Stub the scroller geometry as "scrolled up" and fire a scroll so the pane records it.
    const list = container.querySelector(".messagelist") as HTMLElement;
    let scrollHeight = 1000;
    Object.defineProperty(list, "scrollHeight", { configurable: true, get: () => scrollHeight });
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 120 });
    list.scrollTop = 200; // distance from bottom = 680 → not near bottom
    await act(async () => {
      list.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    // An agent (not the viewer) posts while the viewer is reading history.
    scrollHeight = 1120; // the feed grew by 120px; preserve the reader's visual anchor (#656).
    await act(async () => {
      rt.fire({ type: "message", message: makeMessage({ id: "m2", authorMemberId: "ag1", body: "scrolled-up reply" }) });
    });

    const pill = await screen.findByRole("button", { name: /1 new message/i });
    expect(pill).toBeInTheDocument();
    expect(list.scrollTop).toBe(320);

    await userEvent.click(pill);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /new message/i })).not.toBeInTheDocument(),
    );
  });

  it("keeps thread replies out of the channel unless they were also sent to it", async () => {
    const { store } = renderWithStore(<MessagePane />, {
      messages: [
        makeMessage({ id: "root", body: "deploy thread" }),
        makeMessage({ id: "r1", parentMessageId: "root", body: "hidden reply" }),
        makeMessage({ id: "r2", parentMessageId: "root", alsoSentToChannel: true, body: "shared reply" }),
      ],
    });
    await store.bootstrap();

    expect(await screen.findByText("deploy thread")).toBeInTheDocument();
    expect(screen.getByText("shared reply")).toBeInTheDocument();
    expect(screen.queryByText("hidden reply")).not.toBeInTheDocument();
  });

  it("opens a thread when a message's reply control is clicked", async () => {
    const { store } = renderWithStore(<MessagePane />);
    await store.bootstrap();
    await screen.findByText("first post");

    await userEvent.click(screen.getByRole("button", { name: /reply in thread/i }));
    await waitFor(() => expect(store.getState().thread?.root.id).toBe("m1"));
  });

  // #168 — bug 4: the composer keeps a per-channel draft, so switching channels never leaks the
  // previous channel's unsent text, and coming back restores that channel's own draft.
  it("isolates and restores composer drafts per channel", async () => {
    const { store } = renderWithStore(<MessagePane />);
    await store.bootstrap(); // selects c1

    const composer = (): HTMLTextAreaElement => screen.getByRole("textbox") as HTMLTextAreaElement;
    await userEvent.type(composer(), "draft for general");
    expect(composer()).toHaveValue("draft for general");

    // Switch to c2 → the input is empty (no stale text from c1).
    await act(async () => {
      await store.selectChannel("c2");
    });
    expect(composer()).toHaveValue("");

    await userEvent.type(composer(), "draft for random");
    expect(composer()).toHaveValue("draft for random");

    // Back to c1 → its own draft is restored, not c2's.
    await act(async () => {
      await store.selectChannel("c1");
    });
    expect(composer()).toHaveValue("draft for general");
  });

  // #509: an empty channel is not a dead end — it offers concrete, department-specific starter prompts so a
  // new user knows what to ask in (e.g.) #seo, and tapping one drops it into the composer ready to send.
  it("offers department starter prompts in an empty channel", async () => {
    const { store } = renderWithStore(<MessagePane />, {
      channels: [{ id: "c1", workspaceId: "w1", kind: "public", name: "seo", isArchived: false }],
      messages: [],
    });
    await store.bootstrap();

    // The empty-state heading and the #seo-specific prompts are shown (not a bare "Quiet in here").
    expect(await screen.findByText(VOICE.startersHeading)).toBeInTheDocument();
    for (const prompt of CHANNEL_STARTERS.seo!) {
      expect(screen.getByRole("button", { name: prompt })).toBeInTheDocument();
    }
  });

  it("prefills the composer when a starter prompt is tapped", async () => {
    const { store } = renderWithStore(<MessagePane />, {
      channels: [{ id: "c1", workspaceId: "w1", kind: "public", name: "seo", isArchived: false }],
      messages: [],
    });
    await store.bootstrap();

    const prompt = CHANNEL_STARTERS.seo![0]!;
    await userEvent.click(await screen.findByRole("button", { name: prompt }));

    // The brief lands in the composer (editable, not auto-sent) and is saved as this channel's draft.
    expect(screen.getByRole("textbox")).toHaveValue(prompt);
    expect(store.getDraft("c1")).toBe(prompt);
  });

  // A channel without a department still suggests something — the generic cross-fleet set, never a blank state.
  it("falls back to generic starter prompts for a non-department channel", async () => {
    const { store } = renderWithStore(<MessagePane />, {
      channels: [{ id: "c1", workspaceId: "w1", kind: "public", name: "general", isArchived: false }],
      messages: [],
    });
    await store.bootstrap();

    expect(await screen.findByText(VOICE.startersHeading)).toBeInTheDocument();
    // At least two clickable first actions are offered.
    const heading = screen.getByText(VOICE.startersHeading);
    const list = heading.parentElement!.querySelector(".starters__list")!;
    expect(list.querySelectorAll("button").length).toBeGreaterThanOrEqual(2);
  });

  // #378: a DM peer reframes the header as a 1:1 over the resolved channel's real message stream.
  it("frames the header as a direct message when a dmPeer is given", async () => {
    const { store } = renderWithStore(
      <MessagePane dmPeer={{ id: "sc", kind: "agent", displayName: "Scout" }} />,
    );
    await store.bootstrap();

    expect(await screen.findByRole("heading", { name: /direct message with scout/i })).toBeInTheDocument();
    // The channel's real history is still shown (the 1:1 is the agent's department channel, not invented).
    expect(screen.getByText("first post")).toBeInTheDocument();
  });
});
