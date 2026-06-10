import { describe, it, expect } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ServerEvent } from "../../api/types.js";
import { Workspace } from "../Workspace.js";
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

/** Boot the workspace, open the Run tab, and select the session — the shared setup for these tests. */
async function openRunTab(): Promise<ReturnType<typeof renderWithStore>> {
  const rendered = renderWithStore(<Workspace />, { sessions: [SESSION] });
  await rendered.store.bootstrap();
  await userEvent.click(screen.getByRole("button", { name: "Run" }));
  await userEvent.click(await screen.findByRole("button", { name: /agent\/s1/ }));
  return rendered;
}

describe("RunPanel (#56 Run tab)", () => {
  it("switches to the Run tab from the top bar", async () => {
    const { store } = renderWithStore(<Workspace />, { sessions: [SESSION] });
    await store.bootstrap();
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(await screen.findByRole("heading", { name: "Annotations" })).toBeInTheDocument();
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
