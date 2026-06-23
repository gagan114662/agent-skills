import { describe, it, expect } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ServerEvent } from "../../api/types.js";
import { RunPanel } from "./RunPanel.js";
import { renderWithStore } from "../../test/utils.js";
import type { AgentSessionSummary } from "../../api/types.js";

const SESSION: AgentSessionSummary = {
  id: "s1",
  channelId: "c1",
  agentMemberId: "ag1",
  status: "completed",
  result: null,
  branch: "agent/s1",
  baseBranch: "main",
  headSha: null,
  createdAt: "2026-06-09T00:00:00.000Z",
  provider: null,
  model: null,
  effort: null,
  mode: null,
};

/** Fire a gateway event inside act(...) so React flushes the resulting state update synchronously. */
function fire(rt: { fire: (e: ServerEvent) => void }, event: ServerEvent): void {
  act(() => rt.fire(event));
}

/**
 * Render the Run surface directly and select the session — the shared setup for these tests.
 * #122 removed the Run tab from product chrome; operators reach the panel via the existing API/route,
 * so the test mounts it straight (bootstrap seeds the active channel its data effect depends on).
 */
async function openRunTab(): Promise<ReturnType<typeof renderWithStore>> {
  const rendered = renderWithStore(<RunPanel />, { sessions: [SESSION] });
  await rendered.store.bootstrap();
  await userEvent.click(await screen.findByRole("button", { name: /agent\/s1/ }));
  return rendered;
}

const FAILED_SESSION: AgentSessionSummary = {
  ...SESSION,
  id: "f1",
  status: "failed",
  branch: "agent/f1",
  failure: {
    failureClass: "overloaded",
    headline: "Claude's servers were overloaded, so I had to stop",
    detail: "This is a temporary capacity blip on the model's side — hit Retry and I'll pick this right back up.",
  },
};

describe("RunPanel (#56 Run tab)", () => {
  it("explains what creates the empty session and annotation states (#649)", async () => {
    const rendered = renderWithStore(<RunPanel />, { sessions: [] });
    await rendered.store.bootstrap();

    expect(await screen.findByText(/Agent sessions appear here after a task starts/i)).toBeInTheDocument();
    expect(screen.getByText(/Ask an agent in chat/i)).toBeInTheDocument();
    expect(screen.getByText(/Annotations you place on the preview appear here/i)).toBeInTheDocument();
    expect(screen.getByText(/Turn on Annotate, click the preview/i)).toBeInTheDocument();
  });

  it("renders the run surface with the annotations rail", async () => {
    await openRunTab();
    expect(await screen.findByRole("heading", { name: "Annotations" })).toBeInTheDocument();
  });

  it("surfaces a failed run's human-readable cause + failing step — never silent (#634)", async () => {
    const rendered = renderWithStore(<RunPanel />, { sessions: [FAILED_SESSION] });
    await rendered.store.bootstrap();
    // The sidebar marks the failed run; selecting it shows the failure banner.
    await userEvent.click(await screen.findByRole("button", { name: /agent\/f1/ }));
    const banner = await screen.findByRole("alert", { name: "Run failed" });
    expect(banner).toHaveTextContent("Claude's servers were overloaded");
    expect(banner).toHaveTextContent(/Failing step/i);
    expect(banner).toHaveTextContent("overloaded");
  });

  it("retries a failed run with a re-briefed task (#634)", async () => {
    const { store } = renderWithStore(<RunPanel />, { sessions: [FAILED_SESSION] });
    await store.bootstrap();
    await userEvent.click(await screen.findByRole("button", { name: /agent\/f1/ }));

    // Retry is gated on a re-brief: disabled until the operator supplies a task.
    const retryBtn = screen.getByRole("button", { name: "Retry" });
    expect(retryBtn).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Re-brief and retry"), "ship the homepage again");
    expect(retryBtn).toBeEnabled();
    await userEvent.click(retryBtn);

    // The re-launch (fake → "sess_retry") becomes the selected run.
    await waitFor(() => expect(store.getState().run.activeSessionId).toBe("sess_retry"));
  });

  it("starts a run and shows the live preview iframe once the app's url is detected", async () => {
    const { rt } = await openRunTab();

    await userEvent.click(screen.getByRole("button", { name: "Run app" }));
    // The server detects the bound port and broadcasts a run_status event.
    fire(rt, {
      type: "run_status",
      sessionId: "s1",
      channelId: "c1",
      status: "running",
      url: "http://localhost:5173",
    });

    const iframe = await screen.findByTitle("App preview");
    expect(iframe).toHaveAttribute("src", "http://localhost:5173");
    expect(screen.getByText("http://localhost:5173")).toBeInTheDocument();
  });

  it("streams run logs into the panel", async () => {
    const { rt } = await openRunTab();
    await userEvent.click(screen.getByRole("button", { name: "Run app" }));
    fire(rt, { type: "run_status", sessionId: "s1", channelId: "c1", status: "running", url: "http://localhost:3000" });
    fire(rt, { type: "run_log", sessionId: "s1", channelId: "c1", chunk: "compiled successfully" });

    const logs = await screen.findByLabelText("Run logs");
    await waitFor(() => expect(logs).toHaveTextContent("compiled successfully"));
  });

  it("captures a preview annotation and delivers it to the agent", async () => {
    const { store, rt } = await openRunTab();
    await userEvent.click(screen.getByRole("button", { name: "Run app" }));
    fire(rt, { type: "run_status", sessionId: "s1", channelId: "c1", status: "running", url: "http://localhost:5173" });
    await screen.findByTitle("App preview");

    // Enter annotate mode, click the preview overlay, type a note, and add it.
    await userEvent.click(screen.getByRole("button", { name: "Annotate" }));
    await userEvent.click(screen.getByTestId("run-overlay"));
    await userEvent.type(screen.getByLabelText("Annotation note"), "the Save button is misaligned");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(screen.getByText("the Save button is misaligned")).toBeInTheDocument();
    expect(store.getState().run.annotations).toHaveLength(1);

    // Deliver to the agent → the collected annotations are sent and cleared.
    await userEvent.click(screen.getByRole("button", { name: /Deliver to agent/ }));
    await waitFor(() => expect(store.getState().run.annotations).toHaveLength(0));
  });
});
