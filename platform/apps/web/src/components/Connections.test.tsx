import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { Connections } from "./Connections.js";
import type { ConnectionsResponse, ConnectionView } from "../api/types.js";

/**
 * #258 — the OAuth-first Connections panel (presentational). Customers see consumer-OAuth connectors only
 * ("Sign in with Google", "Connect X"); the GitHub paste form is admin-only and never rendered for a
 * customer. OAuth connectors that aren't live yet are honestly disabled ("Coming soon").
 */
function view(over: Partial<ConnectionView>): ConnectionView {
  return {
    id: "google",
    label: "Sign in with Google",
    summary: "One consent connects Search Console + Analytics.",
    provider: "google",
    kind: "analytics",
    audience: "customer",
    auth: "oauth",
    status: "coming_soon",
    capabilities: ["search_console"],
    oauthScopes: ["webmasters"],
    connected: false,
    ...over,
  };
}

const CUSTOMER: ConnectionsResponse = {
  canManageInternal: false,
  connections: [view({ id: "google" }), view({ id: "x", label: "Connect X", auth: "oauth" })],
};

describe("Connections (#258)", () => {
  it("shows a loading state until the data arrives", () => {
    render(<Connections data={null} onOAuthConnect={() => {}} onInternalConnect={() => {}} onDisconnect={() => {}} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("renders customer connectors as OAuth buttons, disabled when coming soon", () => {
    render(<Connections data={CUSTOMER} onOAuthConnect={() => {}} onInternalConnect={() => {}} onDisconnect={() => {}} />);
    expect(screen.getByText("Sign in with Google")).toBeInTheDocument();
    expect(screen.getByText("Connect X")).toBeInTheDocument();
    // coming_soon ⇒ the connect button is disabled and a "coming soon" affordance is shown
    expect(screen.getAllByText(/coming soon/i).length).toBeGreaterThan(0);
  });

  it("never shows the internal GitHub paste form to a customer (no admin form)", () => {
    render(<Connections data={CUSTOMER} onOAuthConnect={() => {}} onInternalConnect={() => {}} onDisconnect={() => {}} />);
    expect(screen.queryByLabelText(/repository/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/access token/i)).not.toBeInTheDocument();
  });

  it("calls onOAuthConnect when an available OAuth connector is clicked", () => {
    const onOAuthConnect = vi.fn();
    const data: ConnectionsResponse = {
      canManageInternal: false,
      connections: [view({ id: "google", status: "available" })],
    };
    render(<Connections data={data} onOAuthConnect={onOAuthConnect} onInternalConnect={() => {}} onDisconnect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));
    expect(onOAuthConnect).toHaveBeenCalledWith("google");
  });

  it("renders the admin paste form and submits repo + token when the owner manages internal", () => {
    const onInternalConnect = vi.fn();
    const data: ConnectionsResponse = {
      canManageInternal: true,
      connections: [
        view({ id: "google" }),
        view({
          id: "site_publish_github",
          label: "Site publishing (internal)",
          audience: "internal",
          auth: "paste_internal",
          status: "available",
        }),
      ],
    };
    render(<Connections data={data} onOAuthConnect={() => {}} onInternalConnect={onInternalConnect} onDisconnect={() => {}} />);
    const form = screen.getByText(/site publishing/i).closest("section") as HTMLElement;
    fireEvent.change(within(form).getByLabelText(/repository/i), { target: { value: "ipop/site" } });
    fireEvent.change(within(form).getByLabelText(/access token/i), { target: { value: "ghp_x" } });
    fireEvent.click(within(form).getByRole("button", { name: /connect publishing/i }));
    expect(onInternalConnect).toHaveBeenCalledWith("site_publish_github", { repo: "ipop/site", token: "ghp_x", baseBranch: "" });
  });

  it("hides the internal paste form when already connected (shows badge + disconnect instead)", () => {
    const onDisconnect = vi.fn();
    const data: ConnectionsResponse = {
      canManageInternal: true,
      connections: [
        view({
          id: "site_publish_github",
          label: "Site publishing (internal)",
          audience: "internal",
          auth: "paste_internal",
          status: "available",
          connected: true,
        }),
      ],
    };
    render(<Connections data={data} onOAuthConnect={() => {}} onInternalConnect={() => {}} onDisconnect={onDisconnect} />);
    // No free-text inputs when connected — only a disconnect affordance.
    expect(screen.queryByLabelText(/repository/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/access token/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    expect(onDisconnect).toHaveBeenCalledWith("site_publish_github");
  });

  it("offers Disconnect for a connected connector", () => {
    const onDisconnect = vi.fn();
    const data: ConnectionsResponse = {
      canManageInternal: false,
      connections: [view({ id: "google", status: "available", connected: true })],
    };
    render(<Connections data={data} onOAuthConnect={() => {}} onInternalConnect={() => {}} onDisconnect={onDisconnect} />);
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    expect(onDisconnect).toHaveBeenCalledWith("google");
  });
});
