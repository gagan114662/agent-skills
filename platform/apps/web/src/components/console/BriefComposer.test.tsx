/**
 * BriefComposer (#235) — the owner's working control for pointing the fleet at a goal. Presentational +
 * intent-only: it raises `onBrief(lead, goal)` and renders the outcome; the actual launch (and every gate
 * behind it) lives on the server. These tests pin: a goal is required before it fires; the selected lead +
 * goal are handed up; and the launched / connect / error outcomes render the right brand copy.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BriefComposer } from "./BriefComposer.js";
import { CONSOLE, consoleBriefLaunched, consoleBriefConnect } from "../../brand.js";

const LEADS = CONSOLE.brief.leads;

describe("#235 BriefComposer", () => {
  it("won't fire an empty brief — it asks for a goal first", async () => {
    const onBrief = vi.fn(async () => "launched" as const);
    render(<BriefComposer leads={LEADS} onBrief={onBrief} />);

    await userEvent.click(screen.getByRole("button", { name: CONSOLE.brief.submit }));

    expect(onBrief).not.toHaveBeenCalled();
    expect(screen.getByText(CONSOLE.brief.goalRequired)).toBeInTheDocument();
  });

  it("briefs the selected lead with the typed goal and confirms the launch", async () => {
    const onBrief = vi.fn(async () => "launched" as const);
    render(<BriefComposer leads={LEADS} onBrief={onBrief} />);

    // Pick Echo (social) instead of the default first lead.
    await userEvent.click(screen.getByRole("radio", { name: /Echo/ }));
    await userEvent.type(screen.getByRole("textbox"), "get us our first paying founders");
    await userEvent.click(screen.getByRole("button", { name: CONSOLE.brief.submit }));

    expect(onBrief).toHaveBeenCalledWith("echo", "get us our first paying founders");
    expect(screen.getByText(consoleBriefLaunched("Echo"))).toBeInTheDocument();
    // The goal is cleared after a successful brief.
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("defaults to the first lead when none is picked", async () => {
    const onBrief = vi.fn(async () => "launched" as const);
    render(<BriefComposer leads={LEADS} onBrief={onBrief} />);

    await userEvent.type(screen.getByRole("textbox"), "rank us for AI marketing agency");
    await userEvent.click(screen.getByRole("button", { name: CONSOLE.brief.submit }));

    expect(onBrief).toHaveBeenCalledWith("scout", "rank us for AI marketing agency");
  });

  it("renders the connect-prompt outcome when the team can't run yet", async () => {
    const onBrief = vi.fn(async () => "connect" as const);
    render(<BriefComposer leads={LEADS} onBrief={onBrief} />);

    await userEvent.type(screen.getByRole("textbox"), "draft a launch post");
    await userEvent.click(screen.getByRole("button", { name: CONSOLE.brief.submit }));

    expect(screen.getByText(consoleBriefConnect("Scout"))).toBeInTheDocument();
  });

  it("renders a quiet error and keeps the goal when the brief fails", async () => {
    const onBrief = vi.fn(async () => "error" as const);
    render(<BriefComposer leads={LEADS} onBrief={onBrief} />);

    await userEvent.type(screen.getByRole("textbox"), "spend $50 on ads");
    await userEvent.click(screen.getByRole("button", { name: CONSOLE.brief.submit }));

    expect(screen.getByText(CONSOLE.brief.error)).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("spend $50 on ads");
  });
});
