import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExperienceOnboarding } from "./ExperienceOnboarding.js";

describe("ExperienceOnboarding (#784)", () => {
  it("starts with the one-input door and no extra workflow chrome", () => {
    render(<ExperienceOnboarding />);

    expect(screen.getByRole("heading", { name: "right then - what are we making pop today?" })).toBeInTheDocument();
    expect(screen.getByLabelText("what are we marketing today?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "wake the fleet" })).toBeDisabled();
    expect(screen.queryByLabelText("guided connections")).not.toBeInTheDocument();
  });

  it("wakes the fleet and narrates product-specific findings", async () => {
    render(<ExperienceOnboarding />);

    await userEvent.type(screen.getByLabelText("what are we marketing today?"), "acme.ai");
    await userEvent.click(screen.getByRole("button", { name: "wake the fleet" }));

    expect(screen.getByRole("heading", { name: "acme.ai" })).toBeInTheDocument();
    expect(screen.getByText("scout is nosing through your site. we won't judge. much.")).toBeInTheDocument();
    expect(screen.getByText("quill found the sharp bit: acme.ai needs one obvious promise.")).toBeInTheDocument();
  });

  it("does not mark mocked connection asks as connected", async () => {
    render(<ExperienceOnboarding />);
    await userEvent.type(screen.getByLabelText("what are we marketing today?"), "acme.ai");
    await userEvent.click(screen.getByRole("button", { name: "wake the fleet" }));

    await userEvent.click(screen.getByRole("button", { name: "connect gmail" }));
    expect(screen.getByRole("status")).toHaveTextContent(/gmail needs a real OAuth handoff/i);
    expect(screen.queryByText(/drafted a reply to a warm lead/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "connect reddit/x" }));
    expect(screen.getAllByRole("status")[1]).toHaveTextContent(/no threads or replies are being invented/i);
    expect(screen.queryByText(/found 3 threads/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "connect site" }));
    expect(screen.getAllByRole("status")[2]).toHaveTextContent(/site publishing needs the real connections panel/i);
    expect(screen.queryByText(/rewrote the hero/i)).not.toBeInTheDocument();
  });

  it("never exposes ship controls from the local mock connection flow", async () => {
    render(<ExperienceOnboarding />);
    await userEvent.type(screen.getByLabelText("what are we marketing today?"), "acme.ai");
    await userEvent.click(screen.getByRole("button", { name: "wake the fleet" }));

    expect(screen.getByText(/no fake replies, scraped threads, or site edits/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "ship it" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "connect gmail" }));
    await userEvent.click(screen.getByRole("button", { name: "connect reddit/x" }));
    await userEvent.click(screen.getByRole("button", { name: "connect site" }));
    expect(screen.queryByRole("button", { name: "ship it" })).not.toBeInTheDocument();
  });
});
