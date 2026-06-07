import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Composer } from "./Composer.js";
import { renderWithStore } from "../test/utils.js";

describe("Composer", () => {
  it("shows a mention autocomplete and inserts the selected member", async () => {
    const { store } = renderWithStore(<Composer />);
    await store.bootstrap();

    const textarea = screen.getByRole("textbox");
    await userEvent.type(textarea, "@At");

    const option = await screen.findByRole("option", { name: /Atlas/ });
    await userEvent.click(option);

    expect(textarea).toHaveValue("@Atlas ");
  });

  it("the autocomplete distinguishes agents from humans", async () => {
    const { store } = renderWithStore(<Composer />);
    await store.bootstrap();
    await userEvent.type(screen.getByRole("textbox"), "@A");

    // Atlas is an agent — its option carries the AGENT marker.
    const option = await screen.findByRole("option", { name: /Atlas/ });
    expect(option).toHaveTextContent(/agent/i);
  });

  it("posts the message to the active channel and clears the input", async () => {
    const { store } = renderWithStore(<Composer />);
    await store.bootstrap();

    const textarea = screen.getByRole("textbox");
    await userEvent.type(textarea, "ship it");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() =>
      expect(store.getState().messagesByChannel.c1?.some((m) => m.body === "ship it")).toBe(true),
    );
    expect(textarea).toHaveValue("");
  });
});
