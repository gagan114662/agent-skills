import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PopLoader } from "./PopLoader.js";

/**
 * #145 loading: a three-dot pop loader replaces every browser-default spinner. The dots scale in
 * sequence with the brand bezier; an accessible status label means a "loading" affordance is always
 * announced (and existing `getByText(/loading/i)` assertions keep passing).
 */
describe("PopLoader", () => {
  it("renders three sequenced dots", () => {
    const { container } = render(<PopLoader />);
    expect(container.querySelectorAll(".poploader__dot")).toHaveLength(3);
  });

  it("exposes a polite status role with its label", () => {
    render(<PopLoader label="Loading the console…" />);
    expect(screen.getByRole("status")).toHaveTextContent(/loading the console/i);
  });

  it("defaults the label so a loader is never silent", () => {
    render(<PopLoader />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });
});
