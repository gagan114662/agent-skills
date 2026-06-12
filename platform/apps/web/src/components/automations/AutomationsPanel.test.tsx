import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AutomationsPanel } from "./AutomationsPanel.js";
import { renderWithStore } from "../../test/utils.js";
import type { TaskTemplateDto } from "../../api/types.js";

const SEO_AUDIT: TaskTemplateDto = {
  key: "seo_audit",
  department: "seo",
  title: "SEO audit",
  description: "Crawl the site.",
  body: "Run an SEO audit of {{site}}.",
  params: [{ key: "site", label: "Site URL", placeholder: "our website" }],
  agentHandle: "scout",
};

interface RouteOpts {
  /** Status + body for the create POST (default 201 with a created row). */
  create?: { status: number; body: unknown };
}

/** Route the api singleton's fetch by method + path; record every call for assertions. */
function stubRoutes(opts: RouteOpts = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    if (method === "GET" && url.includes("/task-templates")) return json(200, [SEO_AUDIT]);
    if (method === "GET" && url.endsWith("/automations")) return json(200, []);
    if (method === "POST" && url.endsWith("/automations")) {
      const c = opts.create ?? { status: 201, body: { id: "a1", name: "Weekly audit", triggerKind: "schedule" } };
      return json(c.status, c.body);
    }
    return json(200, []);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AutomationsPanel (#167 — Create button)", () => {
  it("shows a brand-voice error (not silence) when the template is missing", async () => {
    const fetchMock = stubRoutes();
    const { store } = renderWithStore(<AutomationsPanel />);
    await store.bootstrap();

    await userEvent.type(screen.getByPlaceholderText(/name/i), "Weekly audit");
    const selects = screen.getAllByRole("combobox");
    await userEvent.selectOptions(selects[0]!, "c1"); // channel

    // No template chosen → Create must surface a hint, never fail silently.
    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/task template/i);

    // Crucially: no create request was sent.
    const posted = fetchMock.mock.calls.some(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    expect(posted).toBe(false);
  });

  it("posts the automation and clears the name on success", async () => {
    const fetchMock = stubRoutes();
    const { store } = renderWithStore(<AutomationsPanel />);
    await store.bootstrap();

    const nameInput = screen.getByPlaceholderText(/name/i);
    await userEvent.type(nameInput, "Weekly audit");
    const selects = screen.getAllByRole("combobox");
    await userEvent.selectOptions(selects[0]!, "c1"); // channel → triggers template fetch

    // The template select fills once the channel's templates load.
    await waitFor(() => expect(within(selects[1]!).queryByText(/SEO audit/i)).toBeInTheDocument());
    await userEvent.selectOptions(selects[1]!, "seo_audit");

    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
      expect(post).toBeTruthy();
    });
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST")!;
    expect(String(post[0])).toBe("/workspaces/w1/automations");
    const sent = JSON.parse((post[1] as RequestInit).body as string);
    expect(sent).toMatchObject({ name: "Weekly audit", channelId: "c1", templateKey: "seo_audit", triggerKind: "schedule" });

    await waitFor(() => expect(nameInput).toHaveValue(""));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("surfaces a server validation failure instead of swallowing it", async () => {
    stubRoutes({ create: { status: 400, body: { error: "templateKey must reference a known template" } } });
    const { store } = renderWithStore(<AutomationsPanel />);
    await store.bootstrap();

    await userEvent.type(screen.getByPlaceholderText(/name/i), "Weekly audit");
    const selects = screen.getAllByRole("combobox");
    await userEvent.selectOptions(selects[0]!, "c1");
    await waitFor(() => expect(within(selects[1]!).queryByText(/SEO audit/i)).toBeInTheDocument());
    await userEvent.selectOptions(selects[1]!, "seo_audit");

    await userEvent.click(screen.getByRole("button", { name: /^create$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/must reference a known template/i);
  });
});
