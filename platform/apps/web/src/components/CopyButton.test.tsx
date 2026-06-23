import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VOICE } from "../brand.js";
import { CopyButton, copyTextToClipboard } from "./CopyButton.js";

function setClipboard(writeText: ((text: string) => Promise<void>) | undefined): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  setClipboard(undefined);
});

describe("CopyButton (#657)", () => {
  it("writes text to the clipboard and confirms", async () => {
    const writeText = vi.fn(async () => undefined);
    setClipboard(writeText);
    render(<CopyButton text="ship it" />);

    await userEvent.click(screen.getByRole("button", { name: VOICE.copy.label }));

    expect(writeText).toHaveBeenCalledWith("ship it");
    expect(await screen.findByRole("status")).toHaveTextContent(VOICE.copy.done);
  });

  it("surfaces an error when clipboard write fails", async () => {
    setClipboard(vi.fn(async () => {
      throw new Error("blocked");
    }));
    render(<CopyButton text="ship it" />);

    await userEvent.click(screen.getByRole("button", { name: VOICE.copy.label }));

    expect(await screen.findByRole("alert")).toHaveTextContent(VOICE.copy.failed);
  });

  it("falls back to the copy command when navigator.clipboard is unavailable", async () => {
    setClipboard(undefined);
    const exec = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: exec,
    });

    await copyTextToClipboard("fallback text");

    expect(exec).toHaveBeenCalledWith("copy");
    await waitFor(() => expect(document.querySelector("textarea")).toBeNull());
  });
});
