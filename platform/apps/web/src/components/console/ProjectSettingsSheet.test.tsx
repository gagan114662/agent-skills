import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CONSOLE } from "../../brand.js";
import { ProjectSettingsSheet } from "./ProjectSettingsSheet.js";
import type { ConsoleProject } from "./model.js";
import { api } from "../../api/client.js";

vi.mock("../../api/client.js", () => ({
  api: {
    skillopt: { proposals: vi.fn() },
    approvals: { approve: vi.fn(), reject: vi.fn() },
  },
}));

const PROJECT: ConsoleProject = {
  id: "p1",
  name: "Launch site",
  hue: "#ff4524",
  items: [],
  counts: { running: 0, waiting: 0, shipped: 0 },
  needsYou: false,
};

describe("ProjectSettingsSheet (#663)", () => {
  it("applies common general settings immediately in the open sheet", () => {
    render(<ProjectSettingsSheet open project={PROJECT} onClose={vi.fn()} />);

    const repo = screen.getByLabelText(CONSOLE.settings.general.repoLabel) as HTMLInputElement;
    fireEvent.change(repo, { target: { value: "Updated launch site" } });

    expect(screen.getByRole("heading", { name: "Updated launch site" })).toBeInTheDocument();
    expect(screen.getAllByText(CONSOLE.settings.general.appliedNow).length).toBeGreaterThan(0);
  });

  it("labels settings that do not apply to the current running process", () => {
    render(<ProjectSettingsSheet open project={PROJECT} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("tab", { name: CONSOLE.settings.tabs.models }));

    expect(screen.getByText(CONSOLE.settings.models.restartRequired)).toBeInTheDocument();
    expect(screen.getAllByText(CONSOLE.settings.models.appliesNextRun)).toHaveLength(
      CONSOLE.settings.models.providers.length,
    );
  });

  it("shows staged SkillOpt proposals with validation receipts and adopts through approvals", async () => {
    vi.mocked(api.skillopt.proposals).mockResolvedValue({
      proposals: [
        {
          id: "p1",
          runId: "run1",
          workspaceId: "w1",
          agentHandle: "scout",
          skillId: "skills/scout/SKILL.md",
          status: "staged",
          skipReason: null,
          clusterKey: "seo-meta",
          metric: "reply_rate",
          higherIsBetter: true,
          baseline: 0.1,
          candidate: 0.2,
          improvementRatio: 1,
          sampleSize: 12,
          externallyVerified: true,
          currentDocSha: "abcdef123456",
          requestId: "req1",
          createdAt: "2026-06-25T11:00:00.000Z",
        },
      ],
    });
    vi.mocked(api.approvals.approve).mockResolvedValue({
      status: "executed",
      result: {},
      request: {} as never,
    });

    render(<ProjectSettingsSheet open project={PROJECT} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: CONSOLE.settings.tabs.skillopt }));

    expect(await screen.findByText("@scout")).toBeInTheDocument();
    expect(screen.getByText(/reply_rate: 0.1 -> 0.2/)).toBeInTheDocument();
    expect(screen.getByText(/external receipt verified/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: CONSOLE.settings.skillopt.adopt }));
    await waitFor(() =>
      expect(api.approvals.approve).toHaveBeenCalledWith(
        "req1",
        CONSOLE.settings.skillopt.adoptReason,
      ),
    );
  });
});
