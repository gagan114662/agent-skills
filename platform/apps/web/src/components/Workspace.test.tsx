/**
 * The authed shell (console v5). The whole product is two panes — left projects → sessions, center board,
 * a drawer to dive in — with NO top nav. These tests pin that: the console is the default surface, the old
 * tab strip (Board / Chat / Founder / Automations / … / Pricing) is gone, the brand shows (not the internal
 * name), and the account utilities that replaced the nav (settings, sign out) live in the left footer.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Workspace } from "./Workspace.js";
import { CONSOLE } from "../brand.js";
import { StoreProvider } from "../store/StoreContext.js";
import { createStore } from "../store/store.js";
import { makeFakeDeps, renderWithStore } from "../test/utils.js";

describe("Workspace shell (console v5)", () => {
  it("opens directly on the two-pane console — left projects panel + a guided first-run center (#213)", async () => {
    const { store } = renderWithStore(<Workspace />);
    await store.bootstrap();

    // LEFT: the Conductor-style projects panel.
    expect(await screen.findByLabelText("Standup")).toBeInTheDocument();
    // CENTER: with no work yet (the seams aren't wired in this shell test), the console shows the first-run
    // activation panel rather than a dead 0/0/0 board — the owner gets a clear path to a first project.
    // (The three board lanes rendering from live data is pinned in ConsoleView.test.)
    expect(screen.getByText(CONSOLE.firstRun.headline)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: CONSOLE.firstRun.cta })).toBeInTheDocument();
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

  it("#658 keeps global error toasts visible until dismissed, with a details link", async () => {
    const { deps } = makeFakeDeps();
    deps.api.missionControl.stop = vi.fn(async () => {
      throw new Error("runner stopped responding while cleaning up");
    });
    const store = createStore(deps);
    render(
      <StoreProvider store={store}>
        <Workspace />
      </StoreProvider>,
    );
    await store.bootstrap();
    await screen.findByLabelText("Standup");

    await store.stopSession("sess_1");

    const toast = await screen.findByRole("alert", { name: CONSOLE.errorToast.title });
    expect(toast).toHaveTextContent("runner stopped responding while cleaning up");
    expect(screen.getByRole("link", { name: CONSOLE.errorToast.details })).toHaveAttribute(
      "href",
      "#workspace-error-details",
    );

    fireEvent.click(screen.getByRole("button", { name: CONSOLE.errorToast.dismiss }));
    expect(screen.queryByRole("alert", { name: CONSOLE.errorToast.title })).toBeNull();
  });
});
