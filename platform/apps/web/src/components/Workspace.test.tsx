/**
 * The authed shell (console v5). The whole product is two panes — left projects → sessions, center board,
 * a drawer to dive in — with NO top nav. These tests pin that: the console is the default surface, the old
 * tab strip (Board / Chat / Founder / Automations / … / Pricing) is gone, the brand shows (not the internal
 * name), and the account utilities that replaced the nav (settings, sign out) live in the left footer.
 */
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { Workspace } from "./Workspace.js";
import { CONSOLE } from "../brand.js";
import { renderWithStore } from "../test/utils.js";

describe("Workspace shell (console v5)", () => {
  it("opens directly on the two-pane console — left projects panel + the three board lanes", async () => {
    const { store } = renderWithStore(<Workspace />);
    await store.bootstrap();

    // LEFT: the Conductor-style projects panel.
    expect(await screen.findByLabelText("Standup")).toBeInTheDocument();
    // CENTER: exactly the three v5 columns (addressed as the board's listitems by their aria-label).
    expect(screen.getByRole("listitem", { name: CONSOLE.columns.running })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: CONSOLE.columns.waiting })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: CONSOLE.columns.shipped })).toBeInTheDocument();
  });

  it("has no top nav — the old Board/Chat/Founder/…/Pricing tab strip is gone", async () => {
    const { store } = renderWithStore(<Workspace />);
    await store.bootstrap();
    await screen.findByLabelText("Standup");

    for (const gone of [
      "Board",
      "Chat",
      "Founder",
      "Automations",
      "Catalog",
      "Workflows",
      "Mission",
      "Audit",
      "Approvals",
      "Deploy",
      "Pricing",
    ]) {
      expect(screen.queryByRole("button", { name: new RegExp(`^${gone}$`) }), gone).toBeNull();
    }
  });

  it("renders the configured brand, not the internal name (#122)", async () => {
    const { store } = renderWithStore(<Workspace />);
    await store.bootstrap();

    // The wordmark (#138) splits the name into glyphs with a popped i-dot, so the brand is exposed via
    // the accessible label rather than a single text node.
    expect(screen.getAllByLabelText(/ipop/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Reload/)).toBeNull();
  });

  it("keeps the account utilities (settings, sign out) in the left footer, not a top bar", async () => {
    const { store } = renderWithStore(<Workspace />);
    await store.bootstrap();
    await screen.findByLabelText("Standup");

    expect(screen.getByRole("button", { name: CONSOLE.shell.settings })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: CONSOLE.shell.signOut })).toBeInTheDocument();
  });
});
