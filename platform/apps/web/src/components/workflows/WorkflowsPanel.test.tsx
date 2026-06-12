import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkflowsPanel } from "./WorkflowsPanel.js";
import { renderWithStore } from "../../test/utils.js";
import type { WorkflowDto, WorkflowInsightsDto } from "../../api/types.js";

const WF: WorkflowDto = {
  id: "wf1",
  workspaceId: "w1",
  name: "Site-live launch kit",
  triggerKind: "schedule",
  trigger: { kind: "schedule" },
  conditions: [{ fact: "catalog.site.active", op: "gte", value: 1 }],
  actions: [{ kind: "notify_owner", message: "ready" }],
  enabled: true,
  lastFiredAt: null,
  nextRunAt: "2026-06-13T09:00:00Z",
  createdAt: "2026-06-12T09:00:00Z",
  updatedAt: "2026-06-12T09:00:00Z",
};

const INSIGHTS: WorkflowInsightsDto = {
  total: 4,
  byStatus: { fired: 3, skipped: 1, blocked: 0, failed: 0 },
  successRate: 1,
  recentFailureReasons: [],
  daily: [],
};

function stubRoutes(opts: { workflows?: WorkflowDto[] } = {}): ReturnType<typeof vi.fn> {
  let workflows = opts.workflows ?? [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (method === "GET" && url.includes("/workflows-insights")) return json(200, INSIGHTS);
    if (method === "GET" && url.includes("/workflows")) return json(200, workflows);
    if (method === "POST" && url.endsWith("/workflows")) {
      workflows = [WF];
      return json(201, WF);
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

describe("WorkflowsPanel (#152)", () => {
  it("renders a workflow as a trigger → condition → action chain with insights", async () => {
    stubRoutes({ workflows: [WF] });
    const { store } = renderWithStore(<WorkflowsPanel />);
    await store.bootstrap();
    await waitFor(() => expect(screen.getByText("Site-live launch kit")).toBeInTheDocument());
    expect(screen.getByText(/when: schedule/i)).toBeInTheDocument();
    expect(screen.getByText(/if: catalog.site.active gte 1/i)).toBeInTheDocument();
    expect(screen.getByText(/then: notify owner/i)).toBeInTheDocument();
    expect(screen.getByText(/100%/)).toBeInTheDocument();
  });

  it("validates the builder and surfaces an error when the name is missing", async () => {
    stubRoutes();
    const { store } = renderWithStore(<WorkflowsPanel />);
    await store.bootstrap();
    await userEvent.click(screen.getByRole("button", { name: /create workflow/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/name/i);
  });

  it("builds a notify-owner workflow", async () => {
    const fetchMock = stubRoutes({ workflows: [] });
    const { store } = renderWithStore(<WorkflowsPanel />);
    await store.bootstrap();
    await userEvent.type(screen.getByLabelText("Workflow name"), "Heads up");
    await userEvent.type(screen.getByLabelText("Action body"), "Something happened");
    await userEvent.click(screen.getByRole("button", { name: /create workflow/i }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u, i]) => String(u).endsWith("/workflows") && i?.method === "POST"),
      ).toBe(true),
    );
  });
});
