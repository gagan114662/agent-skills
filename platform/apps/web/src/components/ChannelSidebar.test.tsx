import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Channel, MemberHit } from "../api/types.js";
import { ChannelSidebar } from "./ChannelSidebar.js";
import { CONSOLE } from "../brand.js";
import { renderWithStore } from "../test/utils.js";

describe("ChannelSidebar", () => {
  it("lists the workspace channels once bootstrapped", async () => {
    const { store } = renderWithStore(<ChannelSidebar />);
    await store.bootstrap();
    expect(await screen.findByText("general")).toBeInTheDocument();
    expect(screen.getByText("random")).toBeInTheDocument();
  });

  it("selects a channel when clicked", async () => {
    const { store } = renderWithStore(<ChannelSidebar />);
    await store.bootstrap();
    await userEvent.click(await screen.findByText("random"));
    await waitFor(() => expect(store.getState().activeChannelId).toBe("c2"));
  });

  it("creates a new channel from the composer", async () => {
    const { store } = renderWithStore(<ChannelSidebar />);
    await store.bootstrap();

    await userEvent.click(screen.getByRole("button", { name: /add channel/i }));
    await userEvent.type(screen.getByPlaceholderText(/new channel/i), "deploys");
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => expect(screen.getByText("deploys")).toBeInTheDocument());
    expect(store.getState().activeChannelId).toBe("c3");
  });

  // #168 — bug 5: Enter in the inline name field confirms (no dead key, no mouse required).
  it("creates a channel when Enter is pressed in the name field", async () => {
    const { store } = renderWithStore(<ChannelSidebar />);
    await store.bootstrap();

    await userEvent.click(screen.getByRole("button", { name: /add channel/i }));
    await userEvent.type(screen.getByPlaceholderText(/new channel/i), "deploys{Enter}");

    await waitFor(() => expect(screen.getByText("deploys")).toBeInTheDocument());
    expect(store.getState().activeChannelId).toBe("c3");
  });

  // #168 — bug 5: the inline field must not linger when you navigate to another channel.
  it("dismisses the add-channel field when navigating to another channel", async () => {
    const { store } = renderWithStore(<ChannelSidebar />);
    await store.bootstrap();
    await screen.findByText("general");

    await userEvent.click(screen.getByRole("button", { name: /add channel/i }));
    await userEvent.type(screen.getByPlaceholderText(/new channel/i), "half-typed");

    // Switching channels closes the field (and abandons the half-typed name).
    await userEvent.click(screen.getByText("random"));
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/new channel/i)).not.toBeInTheDocument(),
    );
  });

  // #168 — bug 5: blurring the field away (without committing) dismisses it.
  it("dismisses the add-channel field on blur", async () => {
    const { store } = renderWithStore(<ChannelSidebar />);
    await store.bootstrap();
    await screen.findByText("general");

    await userEvent.click(screen.getByRole("button", { name: /add channel/i }));
    const input = screen.getByPlaceholderText(/new channel/i);
    await userEvent.type(input, "half-typed");

    fireEvent.blur(input); // focus leaves the form entirely → dismiss
    await waitFor(() =>
      expect(screen.queryByPlaceholderText(/new channel/i)).not.toBeInTheDocument(),
    );
  });
});

// --- #378 reload.chat sidebar: search · PINNED · CHANNELS · DIRECT MESSAGES -------------------------
const DEPT_CHANNELS: Channel[] = [
  { id: "c-general", workspaceId: "w1", kind: "public", name: "general", isArchived: false },
  { id: "c-seo", workspaceId: "w1", kind: "public", name: "seo", isArchived: false },
  { id: "c-launch", workspaceId: "w1", kind: "public", name: "launch", isArchived: false },
];
const DEPT_MEMBERS: MemberHit[] = [
  { id: "me1", kind: "human", displayName: "Ada" },
  { id: "sc", kind: "agent", displayName: "Scout" },
];

describe("ChannelSidebar — reload.chat structure (#378)", () => {
  it("renders search + PINNED + CHANNELS + DIRECT MESSAGES sections", async () => {
    const { store } = renderWithStore(<ChannelSidebar />, {
      channels: DEPT_CHANNELS,
      members: DEPT_MEMBERS,
    });
    await store.bootstrap();

    const c = CONSOLE.coordination.sidebar;
    expect(await screen.findByPlaceholderText(c.searchPlaceholder)).toBeInTheDocument();
    // "launch" is an owner extra → PINNED; "general"/"seo" are canonical → CHANNELS.
    expect(screen.getByText(c.pinned)).toBeInTheDocument();
    expect(screen.getByText(c.channels)).toBeInTheDocument();
    expect(screen.getByText(c.directMessages)).toBeInTheDocument();
    expect(screen.getByText("launch")).toBeInTheDocument();
    expect(screen.getByText("seo")).toBeInTheDocument();
    // Both humans and agents are DM targets.
    expect(screen.getByText("Scout")).toBeInTheDocument();
    expect(screen.getByText("Ada")).toBeInTheDocument();
  });

  it("filters every section by the search box", async () => {
    const { store } = renderWithStore(<ChannelSidebar />, {
      channels: DEPT_CHANNELS,
      members: DEPT_MEMBERS,
    });
    await store.bootstrap();
    await screen.findByText("seo");

    await userEvent.type(screen.getByPlaceholderText(CONSOLE.coordination.sidebar.searchPlaceholder), "scout");
    await waitFor(() => expect(screen.getByText("Scout")).toBeInTheDocument());
    expect(screen.queryByText("seo")).not.toBeInTheDocument();
    expect(screen.queryByText("launch")).not.toBeInTheDocument();
  });

  it("selecting an agent DM resolves to that agent's department channel (opens the 1:1)", async () => {
    const onSelectDm = vi.fn();
    const { store } = renderWithStore(<ChannelSidebar onSelectDm={onSelectDm} />, {
      channels: DEPT_CHANNELS,
      members: DEPT_MEMBERS,
    });
    await store.bootstrap();

    await userEvent.click(await screen.findByText("Scout"));
    expect(onSelectDm).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "Scout", kind: "agent" }),
      "c-seo",
    );
  });
});
