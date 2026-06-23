import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { StandupPanel } from "./StandupPanel.js";
import type { ConsoleProject } from "./model.js";

const projects: ConsoleProject[] = [
  {
    id: "p-seo",
    name: "SEO",
    hue: "#ff4524",
    items: [],
    counts: { running: 0, waiting: 0, shipped: 0 },
    needsYou: false,
  },
  {
    id: "p-content",
    name: "Content",
    hue: "#0a7cff",
    items: [],
    counts: { running: 0, waiting: 0, shipped: 0 },
    needsYou: true,
  },
];

function renderPanel(over: Partial<ComponentProps<typeof StandupPanel>> = {}) {
  const props: ComponentProps<typeof StandupPanel> = {
    projects,
    activeProjectId: "p-seo",
    openProjectIds: new Set(["p-seo"]),
    onToggleProject: vi.fn(),
    onSelectProject: vi.fn(),
    onOpenSettings: vi.fn(),
    onPeek: vi.fn(),
    filterNeedsYou: false,
    onToggleFilter: vi.fn(),
    activeItemKey: null,
    onOpenWorkspaceSettings: vi.fn(),
    onSignOut: vi.fn(),
    onNewProject: vi.fn(),
    newProjectBusy: false,
    ...over,
  };
  render(<StandupPanel {...props} />);
  return props;
}

describe("StandupPanel", () => {
  it("labels project switcher buttons and marks the active project", async () => {
    const user = userEvent.setup();
    const props = renderPanel();

    const seo = screen.getByRole("button", { name: "Switch to workspace project: SEO" });
    expect(seo).toHaveAttribute("aria-current", "page");

    await user.click(screen.getByRole("button", { name: "Switch to workspace project: Content" }));

    expect(props.onToggleProject).toHaveBeenCalledWith("p-content");
    expect(props.onSelectProject).toHaveBeenCalledWith(projects[1]);
  });
});
