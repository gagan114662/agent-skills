import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CatalogPanel } from "./CatalogPanel.js";
import { renderWithStore } from "../../test/utils.js";
import type { CatalogEntryDto } from "../../api/types.js";

const SITE: CatalogEntryDto = {
  id: "ce1",
  workspaceId: "w1",
  kind: "site",
  name: "ipop.ai",
  identifier: "https://ipop.ai",
  status: "active",
  provenance: "manual",
  ownerMemberId: null,
  metadata: {},
  createdByMemberId: "me1",
  createdAt: "2026-06-12T09:00:00Z",
  updatedAt: "2026-06-12T09:00:00Z",
};

function stubRoutes(opts: { listStatus?: number; entries?: CatalogEntryDto[] } = {}): ReturnType<typeof vi.fn> {
  let entries = opts.entries ?? [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (method === "GET" && url.includes("/catalog")) {
      if (opts.listStatus && opts.listStatus !== 200) return json(opts.listStatus, { error: "off" });
      return json(200, entries);
    }
    if (method === "POST" && url.includes("/catalog")) {
      entries = [SITE];
      return json(201, SITE);
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

describe("CatalogPanel (#152)", () => {
  it("lists registered assets", async () => {
    stubRoutes({ entries: [SITE] });
    const { store } = renderWithStore(<CatalogPanel />);
    await store.bootstrap();
    await waitFor(() => expect(screen.getByText("ipop.ai")).toBeInTheDocument());
    expect(screen.getByText("https://ipop.ai")).toBeInTheDocument();
  });

  it("shows a friendly dark state when the catalog feature is off (403)", async () => {
    stubRoutes({ listStatus: 403 });
    const { store } = renderWithStore(<CatalogPanel />);
    await store.bootstrap();
    await waitFor(() => expect(screen.getByText(/isn’t enabled/i)).toBeInTheDocument());
  });

  it("adds an asset via the form", async () => {
    const fetchMock = stubRoutes({ entries: [] });
    const { store } = renderWithStore(<CatalogPanel />);
    await store.bootstrap();
    await userEvent.type(screen.getByLabelText("Name"), "ipop.ai");
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u, i]) => String(u).includes("/catalog") && i?.method === "POST")).toBe(true),
    );
  });
});
