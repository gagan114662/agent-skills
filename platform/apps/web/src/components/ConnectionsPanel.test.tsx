import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ConnectionsPanel } from "./ConnectionsPanel.js";
import { api } from "../api/client.js";
import type { ConnectionsResponse, ConnectionView } from "../api/types.js";

vi.mock("../api/client.js", () => ({
  api: {
    getConnections: vi.fn(),
    startConnectionOAuth: vi.fn(),
    enableConnection: vi.fn(),
    joinConnectionWaitlist: vi.fn(),
    connectInternal: vi.fn(),
    disconnectConnection: vi.fn(),
  },
}));

function connection(over: Partial<ConnectionView> = {}): ConnectionView {
  return {
    id: "google",
    label: "Sign in with Google",
    summary: "One consent connects Search Console + Analytics.",
    provider: "google",
    kind: "analytics",
    audience: "customer",
    auth: "oauth",
    status: "available",
    capabilities: ["search_console"],
    oauthScopes: ["webmasters"],
    consentStatus: "none",
    providerStatus: "unproven",
    lastProofAt: null,
    lastProofReceipt: null,
    failureReason: null,
    connected: false,
    ...over,
  };
}

function response(connections: ConnectionView[]): ConnectionsResponse {
  return { connections, canManageInternal: false };
}

describe("ConnectionsPanel OAuth redirect (#1285)", () => {
  const originalLocation = window.location;
  let assign: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, assign },
    });
    vi.mocked(api.getConnections).mockResolvedValue(response([connection()]));
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("follows the approved-request authorizePath returned by OAuth start", async () => {
    vi.mocked(api.startConnectionOAuth).mockResolvedValue({
      status: "pending_approval",
      requestId: "req-1",
      authorizePath: "/me/connections/google/oauth/authorize?requestId=req-1",
      provider: "google",
      scopes: ["webmasters"],
      message: "approval ready",
    });
    render(<ConnectionsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: /sign in with google/i }));

    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("/me/connections/google/oauth/authorize?requestId=req-1"),
    );
    expect(api.startConnectionOAuth).toHaveBeenCalledWith("google");
  });
});
