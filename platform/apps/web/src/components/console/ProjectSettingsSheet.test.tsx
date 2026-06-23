import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CONSOLE } from "../../brand.js";
import { ProjectSettingsSheet } from "./ProjectSettingsSheet.js";
import type { ConsoleProject } from "./model.js";

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
});
