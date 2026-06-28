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
    statusReason: null,
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

const CUSTOMER: ConnectionsResponse = {
  canManageInternal: false,
  connections: [view({ id: "google" }), view({ id: "x", label: "Connect X", auth: "oauth" })],
};

/** All the handlers wired off by default — individual tests override the one they assert on. */
const noopHandlers = {
  onOAuthConnect: () => {},
  onOneClickConnect: () => {},
  onWaitlist: () => {},
  onInternalConnect: () => {},
  onDisconnect: () => {},
};

describe("Connections (#258)", () => {
  it("shows a loading state until the data arrives", () => {
    render(<Connections data={null} {...noopHandlers} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("renders customer connectors, offering a waitlist next step when coming soon (#507)", () => {
    render(<Connections data={CUSTOMER} {...noopHandlers} />);
    expect(screen.getByText("Sign in with Google")).toBeInTheDocument();
    expect(screen.getByText("Connect X")).toBeInTheDocument();
    // coming_soon ⇒ NOT a dead, disabled button: a "notify me" waitlist button is the next step.
    expect(screen.getAllByRole("button", { name: /notify me/i }).length).toBeGreaterThan(0);
  });

  it("shows the real marketing capabilities a connected account unlocks (#1285)", () => {
    const data: ConnectionsResponse = {
      canManageInternal: false,
      connections: [
        view({
          id: "google",
          status: "available",
          connected: true,
          capabilities: ["search_console", "analytics"],
        }),
      ],
    };
    render(<Connections data={data} {...noopHandlers} />);
    const proof = screen.getByLabelText("Unlocks: Sign in with Google");
    expect(within(proof).getByText("search console")).toBeInTheDocument();
    expect(within(proof).getByText("analytics")).toBeInTheDocument();
  });

  it("shows locked marketing capabilities before the provider is connected (#1285)", () => {
    const data: ConnectionsResponse = {
      canManageInternal: false,
      connections: [view({ id: "google", status: "available", capabilities: ["search_console"] })],
    };
    render(<Connections data={data} {...noopHandlers} />);
    const proof = screen.getByLabelText("Locked until connected: Sign in with Google");
    expect(within(proof).getByText("search console")).toBeInTheDocument();
  });

  it("renders blocked connectors as setup-required with a concrete reason", () => {
    const onOAuthConnect = vi.fn();
    const data: ConnectionsResponse = {
      canManageInternal: false,
      connections: [
        view({
          id: "imessage_room",
          label: "Connect iMessage room",
          status: "blocked",
          statusReason: "Requires a signed Mac relay host; Fly cannot run Apple Messages directly.",
        }),
      ],
    };
    render(<Connections data={data} {...noopHandlers} onOAuthConnect={onOAuthConnect} />);

    expect(screen.getByText(/setup required/i)).toBeInTheDocument();
    expect(screen.getByText(/signed Mac relay host/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /connect imessage room/i }));
    expect(onOAuthConnect).not.toHaveBeenCalled();
  });

  it("never shows the internal GitHub paste form to a customer (no admin form)", () => {
    render(<Connections data={CUSTOMER} {...noopHandlers} />);
    expect(screen.queryByLabelText(/repository/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/access token/i)).not.toBeInTheDocument();
  });

  it("calls onOAuthConnect when an available OAuth connector is clicked", () => {
    const onOAuthConnect = vi.fn();
    const data: ConnectionsResponse = {
      canManageInternal: false,
      connections: [view({ id: "google", status: "available" })],
    };
    render(<Connections data={data} {...noopHandlers} onOAuthConnect={onOAuthConnect} />);
    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));
    expect(onOAuthConnect).toHaveBeenCalledWith("google");
  });

  it("connects an available one-click connector (outbound email) with onOneClickConnect (#529/#507)", () => {
    const onOneClickConnect = vi.fn();
    const data: ConnectionsResponse = {
      canManageInternal: false,
      connections: [view({ id: "email", label: "Connect email", auth: "one_click", status: "available" })],
    };
    render(<Connections data={data} {...noopHandlers} onOneClickConnect={onOneClickConnect} />);
    fireEvent.click(screen.getByRole("button", { name: /connect email/i }));
    expect(onOneClickConnect).toHaveBeenCalledWith("email");
  });

  it("surfaces live-send config blockers even when outbound email is available to connect (#395)", () => {
    const data: ConnectionsResponse = {
      canManageInternal: false,
      connections: [
        view({
          id: "email",
          label: "Connect email",
          auth: "one_click",
          status: "available",
          configIssue: {
            code: "email_outbound_live_send_missing_config",
            missingEnv: [
              "RELOAD_REACH_SEND_PROVIDER=postmark",
              "POSTMARK_SERVER_TOKEN",
              "RELOAD_ACQUISITION_UNSUBSCRIBE_URL",
            ],
            remedy:
              "Set Postmark token/sender env, enable reach live-send and acquisition email with Postmark, add brand/postal/unsubscribe compliance env, then enable Connect email again so ipop can seal provider proof.",
          },
        }),
      ],
    };
    render(<Connections data={data} {...noopHandlers} />);

    expect(screen.getByText(/enable reach live-send and acquisition email/i)).toBeInTheDocument();
    expect(screen.getByText(/RELOAD_REACH_SEND_PROVIDER=postmark/)).toBeInTheDocument();
    expect(screen.getByText(/POSTMARK_SERVER_TOKEN/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /connect email/i })).toBeInTheDocument();
  });

  it("a coming-soon connector waitlists instead of dead-ending, then confirms (#507)", () => {
    const onWaitlist = vi.fn();
    const data: ConnectionsResponse = {
      canManageInternal: false,
      connections: [view({ id: "x", label: "Connect X", auth: "oauth", status: "coming_soon" })],
    };
    render(<Connections data={data} {...noopHandlers} onWaitlist={onWaitlist} />);
    // The connect path is never a disabled "Connect X" dead button for a coming_soon connector.
    expect(screen.queryByRole("button", { name: /connect x/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /notify me/i }));
    expect(onWaitlist).toHaveBeenCalledWith("x");
    // After joining, the user gets an honest confirmation — not another dead stop.
    expect(screen.getByText(/we'll let you know/i)).toBeInTheDocument();
  });

  it("shows the exact Google connector setup issue when OAuth callback config is missing (#1285)", () => {
    const data: ConnectionsResponse = {
      canManageInternal: false,
      connections: [
        view({
          id: "google",
          label: "Sign in with Google",
          status: "coming_soon",
          configIssue: {
            code: "google_connection_oauth_missing_config",
            missingEnv: ["GOOGLE_CONNECTION_OAUTH_REDIRECT_URI"],
            remedy:
              "Set GOOGLE_CONNECTION_OAUTH_REDIRECT_URI to the deployed /me/connections/google/oauth/callback URL and add that exact URI to the Google OAuth client.",
          },
        }),
      ],
    };
    render(<Connections data={data} {...noopHandlers} />);
    expect(screen.getByText(/GOOGLE_CONNECTION_OAUTH_REDIRECT_URI/)).toBeInTheDocument();
    expect(screen.getByText(/connections\/google\/oauth\/callback/)).toBeInTheDocument();
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
    render(<Connections data={data} {...noopHandlers} onInternalConnect={onInternalConnect} />);
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
    render(<Connections data={data} {...noopHandlers} onDisconnect={onDisconnect} />);
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
    render(<Connections data={data} {...noopHandlers} onDisconnect={onDisconnect} />);
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    expect(onDisconnect).toHaveBeenCalledWith("google");
  });

  it("shows setup pending instead of connected for consent without provider proof (#1284)", () => {
    const onDisconnect = vi.fn();
    const data: ConnectionsResponse = {
      canManageInternal: false,
      connections: [
        view({
          id: "email",
          label: "Connect email",
          auth: "one_click",
          status: "available",
          consentStatus: "recorded",
          providerStatus: "unproven",
          failureReason: "Consent is recorded, but no provider health check has passed yet.",
          connected: false,
        }),
      ],
    };
    render(<Connections data={data} {...noopHandlers} onDisconnect={onDisconnect} />);
    expect(screen.getByText(/setup pending/i)).toBeInTheDocument();
    expect(screen.getByText(/provider health check/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Connected$/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    expect(onDisconnect).toHaveBeenCalledWith("email");
  });
});
