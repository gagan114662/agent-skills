import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

/** Boot the workspace and open the Review tab. */
async function openReviewTab(over = {}): Promise<ReturnType<typeof renderWithStore>> {
  const rendered = renderWithStore(<Workspace />, over);
  await rendered.store.bootstrap();
  await userEvent.click(screen.getByRole("button", { name: "Review" }));
  return rendered;
}

describe("ReviewPanel (#51 git/PR/review surface)", () => {
  it("switches to the Review tab and shows the empty session state", async () => {
    await openReviewTab();
    expect(await screen.findByText("No agent sessions in this channel yet.")).toBeInTheDocument();
    expect(screen.getByText("Select a session to review its diff.")).toBeInTheDocument();
  });

  it("selects a session and reveals the diff + comment surface", async () => {
    await openReviewTab({ sessions: [SESSION] });
    await userEvent.click(await screen.findByRole("button", { name: /agent\/s1/ }));
    // The diff header, comment composer, and comment list render once a session is active.
    expect(await screen.findByRole("heading", { name: "Diff" })).toBeInTheDocument();
    expect(screen.getByRole("form", { name: "Add review comment" })).toBeInTheDocument();
    expect(screen.queryByText("Select a session to review its diff.")).not.toBeInTheDocument();
  });

  it("opens a pull request for the active session and lists it", async () => {
    await openReviewTab({ sessions: [SESSION] });
    await userEvent.click(await screen.findByRole("button", { name: /agent\/s1/ }));
    await userEvent.type(screen.getByRole("textbox", { name: "PR title" }), "Ship it");
    await userEvent.click(screen.getByRole("button", { name: "Create PR" }));
    expect(await screen.findByRole("link", { name: /#1 Ship it/ })).toBeInTheDocument();
  });
});
