import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Composer } from "./Composer.js";
import { VOICE } from "../brand.js";
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

  // #168 — bug 3: the typeahead is keyboard-drivable (arrow to move, Enter to pick).
  it("selects a mention with arrow keys and Enter", async () => {
    const { store } = renderWithStore(<Composer />);
    await store.bootstrap();

    const textarea = screen.getByRole("textbox");
    await userEvent.type(textarea, "@"); // bare @ → lists everyone (Ada, then Atlas)
    await screen.findByRole("option", { name: /Ada/ });

    await userEvent.keyboard("{ArrowDown}{Enter}"); // move to Atlas, pick it
    expect(textarea).toHaveValue("@Atlas ");
  });

  // #168 — bug 3: agent options wear their department spectrum hue (dept colors).
  it("tints an agent option with its department colour", async () => {
    const { store } = renderWithStore(<Composer />, {
      members: [
        { id: "me1", kind: "human", displayName: "Ada" },
        { id: "sc1", kind: "agent", displayName: "Scout" }, // SEO lead → #ff4524
      ],
    });
    await store.bootstrap();
    await userEvent.type(screen.getByRole("textbox"), "@Sc");

    const option = await screen.findByRole("option", { name: /Scout/ });
    const tinted = option.querySelector("[style*='--pop-color']");
    expect(tinted).not.toBeNull();
    expect(tinted?.getAttribute("style")).toContain("#ff4524");
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

  // #167 — bug 2: an unresolved {{var}} must never reach an agent.
  it("blocks send while the message still has an unresolved {{placeholder}}", async () => {
    const { store } = renderWithStore(<Composer />);
    await store.bootstrap();

    const textarea = screen.getByRole("textbox");
    // fireEvent (not userEvent.type) so the literal "{{" braces aren't parsed as key escapes.
    fireEvent.change(textarea, { target: { value: "Run an SEO audit of {{site}}" } });
    await userEvent.click(screen.getByRole("button", { name: /send/i }));

    // A brand-voice hint appears, the text is kept, and nothing was posted.
    expect(screen.getByRole("alert")).toHaveTextContent(/fill in the blanks/i);
    expect(textarea).toHaveValue("Run an SEO audit of {{site}}");
    expect(store.getState().messagesByChannel.c1?.some((m) => m.body.includes("{{site}}"))).toBeFalsy();

    // Resolving the placeholder and resending clears the hint and posts.
    await userEvent.clear(textarea);
    await userEvent.type(textarea, "Run an SEO audit of ipop.ai");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    await waitFor(() =>
      expect(store.getState().messagesByChannel.c1?.some((m) => m.body === "Run an SEO audit of ipop.ai")).toBe(true),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // #167 — bug 3: Steer must give feedback, never be a silent no-op.
  it("confirms a steer with a status message instead of doing nothing", async () => {
    const { store } = renderWithStore(<Composer queue />);
    await store.bootstrap();

    await userEvent.type(screen.getByRole("textbox"), "focus on the pricing page");
    await userEvent.click(screen.getByRole("button", { name: /steer the running agent/i }));

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent(/steer sent/i);
    // It also actually stacked the steering message (the #54 path still runs).
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  // #508 — Queue and Steer must explain themselves: an accessible label for screen readers
  // and a hover tooltip (title) so a new user can tell them apart from Send.
  it("labels Queue and Steer with an accessible explanation and a hover tooltip", async () => {
    const { store } = renderWithStore(<Composer queue />);
    await store.bootstrap();

    // The accessible name (aria-label) carries the full explanation, not a bare verb.
    const queue = screen.getByRole("button", { name: /queue this message to send in turn/i });
    const steer = screen.getByRole("button", { name: /steer the running agent/i });

    // The same one-line explanation is exposed as a hover tooltip via `title`.
    expect(queue).toHaveAttribute("title", VOICE.queueTooltip);
    expect(steer).toHaveAttribute("title", VOICE.steerTooltip);

    // The explanations distinguish the two actions (in turn vs. jump ahead) and are distinct from Send.
    expect(VOICE.queueTooltip).not.toBe(VOICE.steerTooltip);
    expect(screen.getByRole("button", { name: /^send$/i })).toBeInTheDocument();
  });
});
