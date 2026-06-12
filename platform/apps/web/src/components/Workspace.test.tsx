import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Workspace } from "./Workspace.js";
import { renderWithStore } from "../test/utils.js";

describe("Workspace shell", () => {
  it("composes the sidebar, message pane, and members rail", async () => {
    const { store } = renderWithStore(<Workspace />);
    await store.bootstrap();

    expect(await screen.findByText("first post")).toBeInTheDocument(); // message pane
    expect(screen.getByText("general")).toBeInTheDocument(); // sidebar
    expect(await screen.findByText("Atlas")).toBeInTheDocument(); // members rail
  });

  it("shows only the slimmed product nav — Chat/Founder/Approvals/Deploy, no Review/Run/Usage (#122)", async () => {
    const { store } = renderWithStore(<Workspace />);
    await store.bootstrap();

    for (const kept of ["Chat", "Founder", "Approvals", "Deploy"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${kept}`) })).toBeInTheDocument();
    }
    for (const removed of ["Review", "Run", "Usage"]) {
      expect(screen.queryByRole("button", { name: new RegExp(`^${removed}`) })).toBeNull();
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

  it("surfaces an unread @mention indicator from the gateway", async () => {
    const { store, rt } = renderWithStore(<Workspace />);
    await store.bootstrap();

    rt.fire({
      type: "mention",
      mention: {
        id: "x1",
        messageId: "m9",
        channelId: "c1",
        mentionedMemberId: "me1",
        authorMemberId: "ag1",
        body: "@Ada please review",
      },
    });

    const bell = await screen.findByRole("button", { name: /mentions/i });
    await waitFor(() => expect(bell).toHaveTextContent("1"));

    await userEvent.click(bell);
    await waitFor(() => expect(store.getState().unreadMentions).toBe(0));
  });

  // #168 — bug 1: the mentions inbox popover must be dismissable, not stuck open until reload.
  it("dismisses the mentions inbox on an outside click", async () => {
    const { store } = renderWithStore(<Workspace />);
    await store.bootstrap();
    await screen.findByText("first post");

    await userEvent.click(screen.getByRole("button", { name: /mentions/i }));
    expect(screen.getByRole("dialog", { name: /mention inbox/i })).toBeInTheDocument();

    // Clicking anywhere outside the popover (here, a message in the pane) closes it.
    await userEvent.click(screen.getByText("first post"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /mention inbox/i })).not.toBeInTheDocument(),
    );
  });

  it("dismisses the mentions inbox when Escape is pressed", async () => {
    const { store } = renderWithStore(<Workspace />);
    await store.bootstrap();
    await screen.findByText("first post");

    await userEvent.click(screen.getByRole("button", { name: /mentions/i }));
    expect(screen.getByRole("dialog", { name: /mention inbox/i })).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /mention inbox/i })).not.toBeInTheDocument(),
    );
  });

  it("dismisses the mentions inbox when the view changes", async () => {
    const { store } = renderWithStore(<Workspace />);
    await store.bootstrap();
    await screen.findByText("first post");

    await userEvent.click(screen.getByRole("button", { name: /mentions/i }));
    expect(screen.getByRole("dialog", { name: /mention inbox/i })).toBeInTheDocument();

    // Switching to another product view (route change) closes the inbox so it never hangs over it.
    await userEvent.click(screen.getByRole("button", { name: /^Founder/ }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /mention inbox/i })).not.toBeInTheDocument(),
    );
  });
});
