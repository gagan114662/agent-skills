/**
 * WorkspaceSwitcher (#510) — the top-left title is a real menu, not dead chrome. These tests pin the bug fix
 * (the title is a button, clicking it opens a switcher) and the menu's affordances: the current workspace is
 * labelled by its #502 marketing-target product when set, and "New product" / "Settings" open the settings
 * overlay. The marketing target is read through the real api client (mocked here); identity comes from the
 * bootstrapped store.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MarketingTargetState } from "../api/types.js";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.js";
import { api } from "../api/client.js";
import { CONSOLE } from "../brand.js";
import { renderWithStore } from "../test/utils.js";

const COPY = CONSOLE.coordination.switcher;

const UNSET: MarketingTargetState = {
  configured: false,
  target: { name: null, url: null, positioning: null, audience: null, competitors: null },
  preamble: null,
};

const SET: MarketingTargetState = {
  configured: true,
  target: { name: "Acme Invoicing", url: "acme.com", positioning: null, audience: null, competitors: null },
  preamble: "- Product: Acme Invoicing",
};

afterEach(() => vi.restoreAllMocks());

describe("WorkspaceSwitcher (#510)", () => {
  it("renders the workspace title as a button, collapsed by default", async () => {
    vi.spyOn(api, "getMarketingTarget").mockResolvedValue(UNSET);
    const { store } = renderWithStore(<WorkspaceSwitcher />);
    await store.bootstrap();

    const trigger = await screen.findByRole("button", { name: COPY.triggerLabel });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens the switcher menu when the title is clicked", async () => {
    vi.spyOn(api, "getMarketingTarget").mockResolvedValue(UNSET);
    const { store } = renderWithStore(<WorkspaceSwitcher />);
    await store.bootstrap();

    await userEvent.click(await screen.findByRole("button", { name: COPY.triggerLabel }));

    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: COPY.newProduct })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: COPY.settings })).toBeInTheDocument();
  });

  it("labels the current workspace with the marketing-target product name when set", async () => {
    vi.spyOn(api, "getMarketingTarget").mockResolvedValue(SET);
    const { store } = renderWithStore(<WorkspaceSwitcher />);
    await store.bootstrap();

    expect(await screen.findByText("Acme Invoicing")).toBeInTheDocument();
  });

  it("opens settings from both 'New product' and 'Settings', closing the menu after each", async () => {
    vi.spyOn(api, "getMarketingTarget").mockResolvedValue(UNSET);
    const onOpenSettings = vi.fn();
    const { store } = renderWithStore(<WorkspaceSwitcher onOpenSettings={onOpenSettings} />);
    await store.bootstrap();

    await userEvent.click(await screen.findByRole("button", { name: COPY.triggerLabel }));
    await userEvent.click(screen.getByRole("menuitem", { name: COPY.newProduct }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: COPY.triggerLabel }));
    await userEvent.click(screen.getByRole("menuitem", { name: COPY.settings }));
    expect(onOpenSettings).toHaveBeenCalledTimes(2);
  });

  it("closes the menu on Escape", async () => {
    vi.spyOn(api, "getMarketingTarget").mockResolvedValue(UNSET);
    const { store } = renderWithStore(<WorkspaceSwitcher />);
    await store.bootstrap();

    await userEvent.click(await screen.findByRole("button", { name: COPY.triggerLabel }));
    expect(await screen.findByRole("menu")).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });
});
