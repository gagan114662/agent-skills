/**
 * VentureBriefPanel (#387) — the owner-facing "Brief a venture" surface that runs ANY company idea through
 * the already-built #96 venture loop. These tests pin: every field is required before it fires; the five
 * fields are mapped onto the loop's product-agnostic IdeaInput and POSTed for the right workspace; and the
 * created venture id/status renders on success. The api client's `submitVenture` is spied so no real network
 * call is made (mirrors how ConsoleView.test stubs `api.department.seed`).
 */
import { describe, expect, it, vi, beforeEach, afterAll } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VentureBriefPanel } from "./VentureBriefPanel.js";
import { api } from "../../api/client.js";
import { CONSOLE } from "../../brand.js";

const submitVenture = vi.spyOn(api, "submitVenture");

const COPY = CONSOLE.ventureBrief;

async function fillAll(): Promise<void> {
  await userEvent.type(screen.getByLabelText(COPY.fields.name.label), "Clinic Payroll");
  await userEvent.type(screen.getByLabelText(COPY.fields.pitch.label), "payroll for solo clinics");
  await userEvent.type(screen.getByLabelText(COPY.fields.targetUser.label), "solo clinic owners");
  await userEvent.type(screen.getByLabelText(COPY.fields.problem.label), "payroll eats their Sundays");
  await userEvent.type(screen.getByLabelText(COPY.fields.whyNow.label), "new state e-filing mandate");
}

describe("#387 VentureBriefPanel", () => {
  // Default to a resolved stub so a spy never falls through to the real (network) client. Each test that
  // needs a specific outcome overrides this.
  beforeEach(() => {
    submitVenture.mockReset();
    submitVenture.mockResolvedValue({ id: "vt_default", status: "intake" } as never);
  });
  afterAll(() => submitVenture.mockRestore());

  it("won't submit until every field is filled", async () => {
    render(<VentureBriefPanel workspaceId="ws_owner_387" />);
    await userEvent.click(screen.getByRole("button", { name: COPY.submit }));
    expect(submitVenture).not.toHaveBeenCalled();
    expect(screen.getByText(COPY.required)).toBeInTheDocument();
  });

  it("maps the five fields onto the venture IdeaInput and posts for the workspace", async () => {
    submitVenture.mockResolvedValue({ id: "vt_1", status: "intake" } as never);
    render(<VentureBriefPanel workspaceId="ws_owner_387" />);
    await fillAll();
    await userEvent.click(screen.getByRole("button", { name: COPY.submit }));

    expect(submitVenture).toHaveBeenCalledWith("ws_owner_387", {
      problem: "payroll eats their Sundays",
      targetUser: "solo clinic owners",
      insight: "Clinic Payroll — payroll for solo clinics",
      wedge: "payroll for solo clinics",
      marketPath: "new state e-filing mandate",
    });
    expect(await screen.findByRole("status")).toHaveTextContent("vt_1");
    expect(screen.getByRole("status")).toHaveTextContent("intake");
  });

  it("shows the branded error and keeps the input when the submit fails", async () => {
    submitVenture.mockRejectedValue(new Error("boom"));
    render(<VentureBriefPanel workspaceId="ws_owner_387" />);
    await fillAll();
    await userEvent.click(screen.getByRole("button", { name: COPY.submit }));

    expect(await screen.findByText(COPY.error)).toBeInTheDocument();
    expect(screen.getByLabelText(COPY.fields.name.label)).toHaveValue("Clinic Payroll");
  });
});
