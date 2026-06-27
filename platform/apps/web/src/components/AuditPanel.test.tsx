import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { api } from "../api/client.js";
import { renderWithStore } from "../test/utils.js";
import { AuditPanel } from "./AuditPanel.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AuditPanel empty state (#649)", () => {
  it("explains which actions create the first audit event", async () => {
    vi.spyOn(api, "getAudit").mockResolvedValue([]);
    const { store } = renderWithStore(<AuditPanel />);
    await store.bootstrap();

    expect(await screen.findByText(/Gated actions, automation runs, agent launches, and Codex returns/i)).toBeInTheDocument();
    expect(screen.getByText(/approve or run one/i)).toBeInTheDocument();
  });
});
