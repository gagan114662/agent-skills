import { describe, it, expect } from "vitest";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ServerEvent } from "../../api/types.js";
import { Workspace } from "../Workspace.js";
import { VOICE } from "../../brand.js";
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

function fire(rt: { fire: (e: ServerEvent) => void }, event: ServerEvent): void {
  act(() => rt.fire(event));
}

/** Boot the workspace, open the Deploy tab, and select the session. */
async function openDeployTab(): Promise<ReturnType<typeof renderWithStore>> {
  const rendered = renderWithStore(<Workspace />, { sessions: [SESSION] });
  await rendered.store.bootstrap();
  await userEvent.click(screen.getByRole("button", { name: "Deploy" }));
  await userEvent.click(await screen.findByRole("button", { name: /agent\/s1/ }));
  return rendered;
}

describe("DeployPanel (#73 Deploy tab)", () => {
  it("switches to the Deploy tab from the top bar", async () => {
    const { store } = renderWithStore(<Workspace />, { sessions: [SESSION] });
    await store.bootstrap();
    await userEvent.click(screen.getByRole("button", { name: "Deploy" }));
    // The pick-a-session prompt now speaks the house voice (#145 empty-state pass).
    expect(await screen.findByText(VOICE.pickSessionToDeploy)).toBeInTheDocument();
  });

  it("deploys the selected session and shows the live URL as a link", async () => {
    await openDeployTab();
    await userEvent.click(screen.getByRole("button", { name: "Deploy app" }));
    const link = await screen.findByRole("link", { name: "https://app.dryrun.reload.app" });
    expect(link).toHaveAttribute("href", "https://app.dryrun.reload.app");
  });

  it("reflects a live deploy_status event in the panel", async () => {
    const { rt } = await openDeployTab();
    await userEvent.click(screen.getByRole("button", { name: "Deploy app" }));
    // The deployment id from the fake is "dep-1"; an error event should surface.
    fire(rt, {
      type: "deploy_status",
      sessionId: "s1",
      channelId: "c1",
      deploymentId: "dep-1",
      status: "unhealthy",
      url: "https://app.dryrun.reload.app",
      error: "simulated outage",
    });
    expect(await screen.findByText("simulated outage")).toBeInTheDocument();
  });
});
