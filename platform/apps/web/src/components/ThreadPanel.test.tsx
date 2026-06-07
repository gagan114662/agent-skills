import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThreadPanel } from "./ThreadPanel.js";
import { renderWithStore } from "../test/utils.js";

describe("ThreadPanel", () => {
  it("renders nothing until a thread is opened", () => {
    renderWithStore(<ThreadPanel />);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("shows the thread root and lets you post a reply", async () => {
    const { store } = renderWithStore(<ThreadPanel />);
    await store.bootstrap();
    await store.openThread("m1");

    expect(await screen.findByText("first post")).toBeInTheDocument();

    await userEvent.type(screen.getByRole("textbox"), "on it");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(screen.getByText("on it")).toBeInTheDocument());
  });

  it("closes the thread", async () => {
    const { store } = renderWithStore(<ThreadPanel />);
    await store.bootstrap();
    await store.openThread("m1");
    await screen.findByText("first post");

    await userEvent.click(screen.getByRole("button", { name: /close thread/i }));
    await waitFor(() => expect(store.getState().thread).toBeNull());
  });
});
