import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { StatusPage } from "./StatusPage.js";
import { api } from "../api/client.js";
import type { StatusPageDto } from "../api/types.js";

const page: StatusPageDto = {
  workspaceName: "Acme",
  overall: "major_outage",
  components: [
    { name: "api", status: "major_outage" },
    { name: "database", status: "operational" },
  ],
  incidents: [
    {
      title: "api availability critical",
      service: "api",
      severity: "critical",
      status: "firing",
      openedAt: "2026-06-11T11:50:00.000Z",
      resolvedAt: null,
    },
  ],
  generatedAt: "2026-06-11T12:00:00.000Z",
};

afterEach(() => vi.restoreAllMocks());

describe("StatusPage", () => {
  it("renders the overall status, components, and incident history for an opted-in slug", async () => {
    vi.spyOn(api, "getStatusPage").mockResolvedValue(page);
    render(<StatusPage slug="acme" />);

    await waitFor(() => expect(screen.getByText(/Acme/)).toBeInTheDocument());
    expect(api.getStatusPage).toHaveBeenCalledWith("acme");
    expect(screen.getByText(/major outage/i)).toBeInTheDocument();
    expect(screen.getByText("api")).toBeInTheDocument();
    expect(screen.getByText(/api availability critical/i)).toBeInTheDocument();
  });

  it("shows a friendly not-found state when the status page is not published (404)", async () => {
    vi.spyOn(api, "getStatusPage").mockRejectedValue(new Error("status page not found"));
    render(<StatusPage slug="missing" />);
    await waitFor(() => expect(screen.getByText(/no status page/i)).toBeInTheDocument());
  });
});
