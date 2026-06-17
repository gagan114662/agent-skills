import { afterEach, describe, expect, it } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, navigate, replace, useRoute } from "./routing.js";

function Probe(): React.JSX.Element {
  const path = useRoute();
  return <span data-testid="path">{path}</span>;
}

afterEach(() => {
  // Reset history so each test starts at "/".
  act(() => navigate("/"));
});

describe("routing", () => {
  it("useRoute reflects the current pathname and reacts to navigate()", () => {
    render(<Probe />);
    expect(screen.getByTestId("path")).toHaveTextContent("/");

    act(() => navigate("/signup"));
    expect(screen.getByTestId("path")).toHaveTextContent("/signup");
    expect(window.location.pathname).toBe("/signup");
  });

  it("navigate() is a no-op when already on the target path (no duplicate history)", () => {
    render(<Probe />);
    act(() => navigate("/login"));
    const before = window.history.length;
    act(() => navigate("/login"));
    expect(window.history.length).toBe(before);
  });

  it("replace() swaps the current entry in place (no new back-stack entry) and re-renders", () => {
    render(<Probe />);
    act(() => navigate("/start")); // land on an intermediate route, as the AuthGate redirect does
    const before = window.history.length;

    act(() => replace("/app/reports"));
    // The location moved and useRoute re-read it…
    expect(screen.getByTestId("path")).toHaveTextContent("/app/reports");
    expect(window.location.pathname).toBe("/app/reports");
    // …but no history entry was added — the intermediate /start is gone, so Back can't return to it.
    expect(window.history.length).toBe(before);
  });

  it("reacts to a popstate event (browser back/forward) by re-reading the location", () => {
    render(<Probe />);
    act(() => navigate("/signup"));
    expect(screen.getByTestId("path")).toHaveTextContent("/signup");

    // Simulate the browser changing the URL on back/forward: location moves, then popstate fires.
    act(() => {
      window.history.replaceState({}, "", "/login");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByTestId("path")).toHaveTextContent("/login");
  });

  it("Link renders an anchor and client-navigates on plain click (no full reload)", async () => {
    render(
      <>
        <Link href="/signup">Get started</Link>
        <Probe />
      </>,
    );
    const link = screen.getByRole("link", { name: /get started/i });
    expect(link).toHaveAttribute("href", "/signup");

    await userEvent.click(link);
    expect(screen.getByTestId("path")).toHaveTextContent("/signup");
  });

  it("Link does not intercept modifier-clicks (lets the browser open a new tab)", async () => {
    render(
      <>
        <Link href="/signup">Get started</Link>
        <Probe />
      </>,
    );
    const link = screen.getByRole("link", { name: /get started/i });
    await userEvent.keyboard("{Meta>}");
    await userEvent.click(link);
    await userEvent.keyboard("{/Meta}");
    // Path unchanged — the modified click was left to the browser.
    expect(screen.getByTestId("path")).toHaveTextContent("/");
  });
});
