import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TemplatePicker } from "./TemplatePicker.js";
import { renderWithStore } from "../test/utils.js";
import type { TaskTemplateDto } from "../api/types.js";

const SEO_AUDIT: TaskTemplateDto = {
  key: "seo_audit",
  department: "seo",
  title: "SEO audit",
  description: "Crawl the site and report the highest-impact SEO fixes.",
  body: "Run an SEO audit of {{site}}. Draft the top fixes — do not send anything externally.",
  params: [{ key: "site", label: "Site URL", placeholder: "our website" }],
  agentHandle: "scout",
};

/** Stub the api singleton's fetch to return a canned task-template list. */
function stubTemplates(templates: TaskTemplateDto[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(templates), { status: 200, headers: { "content-type": "application/json" } }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TemplatePicker (#167 — template variables)", () => {
  it("prompts for each {{var}} and inserts a fully resolved brief", async () => {
    stubTemplates([SEO_AUDIT]);
    const onPick = vi.fn();
    const { store } = renderWithStore(<TemplatePicker onPick={onPick} />);
    await store.bootstrap();

    // Open the gallery and pick the template that carries a {{site}} variable.
    await userEvent.click(screen.getByRole("button", { name: /templates/i }));
    const option = await screen.findByRole("option", { name: /SEO audit/i });
    expect(option).toHaveTextContent(/needs details/i); // flagged as having variables
    await userEvent.click(option);

    // The picker now asks for the variable; Insert is disabled until it's filled.
    const field = await screen.findByLabelText(/site url/i);
    const insert = screen.getByRole("button", { name: /insert brief/i });
    expect(insert).toBeDisabled();
    expect(onPick).not.toHaveBeenCalled(); // never inserts a raw {{site}}

    await userEvent.type(field, "ipop.ai");
    expect(insert).toBeEnabled();
    await userEvent.click(insert);

    expect(onPick).toHaveBeenCalledTimes(1);
    const inserted = onPick.mock.calls[0]![0] as string;
    expect(inserted).toContain("@scout ");
    expect(inserted).toContain("Run an SEO audit of ipop.ai.");
    expect(inserted).not.toContain("{{site}}"); // fully resolved
  });

  it("inserts a no-variable template immediately (no prompt)", async () => {
    stubTemplates([{ ...SEO_AUDIT, key: "x", title: "No vars", body: "Just do the thing.", params: [] }]);
    const onPick = vi.fn();
    const { store } = renderWithStore(<TemplatePicker onPick={onPick} />);
    await store.bootstrap();

    await userEvent.click(screen.getByRole("button", { name: /templates/i }));
    await userEvent.click(await screen.findByRole("option", { name: /No vars/i }));

    await waitFor(() => expect(onPick).toHaveBeenCalledWith("@scout Just do the thing."));
  });
});

describe("TemplatePicker (#474 — dismiss + hide-when-empty)", () => {
  it("hides the control entirely when the channel has no templates", async () => {
    stubTemplates([]);
    const { store } = renderWithStore(<TemplatePicker onPick={vi.fn()} />);
    await act(async () => {
      await store.bootstrap();
    });
    // The whole 'Templates ▾' control is gone — no dead button that only ever says "No templates".
    await waitFor(() => expect(screen.queryByRole("button", { name: /templates/i })).toBeNull());
  });

  it("closes the popover on a channel switch (never sticks open over the new channel)", async () => {
    stubTemplates([SEO_AUDIT]);
    const { store } = renderWithStore(<TemplatePicker onPick={vi.fn()} />);
    await act(async () => {
      await store.bootstrap();
    });

    await userEvent.click(screen.getByRole("button", { name: /templates/i }));
    expect(await screen.findByRole("listbox", { name: /task templates/i })).toBeInTheDocument();

    // Switching channels must reset the popover, not leave it overlapping the message list.
    await act(async () => {
      await store.selectChannel("c2");
    });
    await waitFor(() => expect(screen.queryByRole("listbox", { name: /task templates/i })).toBeNull());
  });

  it("closes the popover on an outside click", async () => {
    stubTemplates([SEO_AUDIT]);
    const { store } = renderWithStore(<TemplatePicker onPick={vi.fn()} />);
    await act(async () => {
      await store.bootstrap();
    });

    await userEvent.click(screen.getByRole("button", { name: /templates/i }));
    expect(await screen.findByRole("listbox", { name: /task templates/i })).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByRole("listbox", { name: /task templates/i })).toBeNull());
  });
});
