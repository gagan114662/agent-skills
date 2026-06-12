import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelSidebar } from "./ChannelSidebar.js";
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
