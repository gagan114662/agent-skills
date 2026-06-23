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

  it("shows each connection ask followed by an immediate visible result", async () => {
    render(<ExperienceOnboarding />);
    await userEvent.type(screen.getByLabelText("what are we marketing today?"), "acme.ai");
    await userEvent.click(screen.getByRole("button", { name: "wake the fleet" }));

    await userEvent.click(screen.getByRole("button", { name: "allow gmail" }));
    expect(screen.getByText("drafted a reply to a warm lead. polite, useful, suspiciously good.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "allow reddit/x" }));
    expect(screen.getByText("found 3 threads where you can genuinely help. drafts are ready.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "allow site" }));
    expect(screen.getByText("rewrote the hero and parked it for approval. no rogue publishing.")).toBeInTheDocument();
  });

  it("only ships after the guided connections are complete", async () => {
    render(<ExperienceOnboarding />);
    await userEvent.type(screen.getByLabelText("what are we marketing today?"), "acme.ai");
    await userEvent.click(screen.getByRole("button", { name: "wake the fleet" }));

    expect(screen.queryByRole("button", { name: "ship it" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "allow gmail" }));
    await userEvent.click(screen.getByRole("button", { name: "allow reddit/x" }));
    await userEvent.click(screen.getByRole("button", { name: "allow site" }));
    await userEvent.click(screen.getByRole("button", { name: "ship it" }));

    expect(screen.getByRole("status")).toHaveTextContent("shipped. quietly heroic, honestly.");
  });
});
