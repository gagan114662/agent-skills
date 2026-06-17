import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConnectClaude } from "./ConnectClaude.js";

/**
 * #68 — Connect Claude settings panel (presentational). Lets the owner connect their own Claude
 * subscription token; the field is masked and the stored token is never rendered back.
 */
describe("ConnectClaude (#68)", () => {
  it("shows a not-connected state with a masked token field", () => {
    render(<ConnectClaude status={{ connected: false, fingerprint: null }} onConnect={() => {}} onDisconnect={() => {}} />);
    expect(screen.getByText(/not connected/i)).toBeInTheDocument();
    const input = screen.getByLabelText(/token/i) as HTMLInputElement;
    expect(input.type).toBe("password"); // masked input — never shows what you type back as text
  });

  it("#263: keeps the token field behind a collapsed Advanced disclosure (no default free-text secret)", () => {
    render(<ConnectClaude status={{ connected: false, fingerprint: null }} onConnect={() => {}} onDisconnect={() => {}} />);
    const input = screen.getByLabelText(/token/i);
    const details = input.closest("details") as HTMLDetailsElement | null;
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false); // collapsed by default — the secret input is not shown until opened
  });

  it("calls onConnect with the pasted token", () => {
    const onConnect = vi.fn();
    render(<ConnectClaude status={{ connected: false, fingerprint: null }} onConnect={onConnect} onDisconnect={() => {}} />);
    fireEvent.change(screen.getByLabelText(/token/i), { target: { value: "sk-ant-oat-xyz" } });
    fireEvent.click(screen.getByRole("button", { name: /connect/i }));
    expect(onConnect).toHaveBeenCalledWith("sk-ant-oat-xyz");
  });

  it("disables Connect until a token is entered", () => {
    render(<ConnectClaude status={{ connected: false, fingerprint: null }} onConnect={() => {}} onDisconnect={() => {}} />);
    expect(screen.getByRole("button", { name: /connect/i })).toBeDisabled();
  });

  it("shows a connected state with the fingerprint and a disconnect action", () => {
    const onDisconnect = vi.fn();
    render(
      <ConnectClaude
        status={{ connected: true, fingerprint: "abc123def456" }}
        onConnect={() => {}}
        onDisconnect={onDisconnect}
      />,
    );
    expect(screen.getByText(/connected/i)).toBeInTheDocument();
    expect(screen.getByText(/abc123def456/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    expect(onDisconnect).toHaveBeenCalled();
  });

  it("the normal connected flow shows a managed-model note and NO model picker", () => {
    render(
      <ConnectClaude
        status={{ connected: true, fingerprint: "fp", model: null }}
        // Even if a model list is passed, the picker stays hidden unless `advanced` is set.
        models={["claude-opus-4-8", "claude-sonnet-4-6"]}
        defaultModel="claude-opus-4-8"
        onConnect={() => {}}
        onDisconnect={() => {}}
        onSelectModel={() => {}}
      />,
    );
    expect(screen.getByText(/managed model/i)).toBeInTheDocument();
    // The fleet runs on a managed default — ordinary owners never see or set a model.
    expect(screen.queryByLabelText(/fleet model/i)).not.toBeInTheDocument();
  });

  it("the advanced (dev) override exposes a model select and calls onSelectModel with the choice", () => {
    const onSelectModel = vi.fn();
    render(
      <ConnectClaude
        status={{ connected: true, fingerprint: "fp", model: null }}
        advanced
        models={["claude-opus-4-8", "claude-sonnet-4-6"]}
        defaultModel="claude-opus-4-8"
        onConnect={() => {}}
        onDisconnect={() => {}}
        onSelectModel={onSelectModel}
      />,
    );
    const select = screen.getByLabelText(/fleet model override/i) as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "claude-sonnet-4-6" } });
    expect(onSelectModel).toHaveBeenCalledWith("claude-sonnet-4-6");
    // Selecting the blank "Managed default" option clears the override (null → managed default).
    fireEvent.change(select, { target: { value: "" } });
    expect(onSelectModel).toHaveBeenCalledWith(null);
  });

  it("the advanced override stays hidden until a model list is provided", () => {
    render(
      <ConnectClaude status={{ connected: true, fingerprint: "fp" }} advanced onConnect={() => {}} onDisconnect={() => {}} />,
    );
    expect(screen.queryByLabelText(/fleet model override/i)).not.toBeInTheDocument();
  });

  it("#262: no managed button by default (paste-first) — backward compatible when no offer is given", () => {
    render(<ConnectClaude status={{ connected: false, fingerprint: null }} onConnect={() => {}} onDisconnect={() => {}} />);
    expect(screen.queryByRole("button", { name: /connect claude account/i })).not.toBeInTheDocument();
    // The setup-token paste field is still reachable (behind Advanced).
    expect(screen.getByLabelText(/token/i)).toBeInTheDocument();
  });

  it("#262: shows a one-click Connect button when the managed flow is available, and starts it", () => {
    const onStartManagedConnect = vi.fn();
    render(
      <ConnectClaude
        status={{ connected: false, fingerprint: null }}
        offer={{ method: "managed_oauth", managed: true, status: "available", reason: null }}
        onConnect={() => {}}
        onDisconnect={() => {}}
        onStartManagedConnect={onStartManagedConnect}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /connect claude account/i }));
    expect(onStartManagedConnect).toHaveBeenCalled();
    // The Advanced paste fallback is still present so the user is never blocked.
    expect(screen.getByLabelText(/token/i)).toBeInTheDocument();
  });

  it("#262: shows an honest coming-soon note (no managed button) while not wired, paste still available", () => {
    render(
      <ConnectClaude
        status={{ connected: false, fingerprint: null }}
        offer={{ method: "managed_oauth", managed: true, status: "coming_soon", reason: "rolling out" }}
        onConnect={() => {}}
        onDisconnect={() => {}}
        onStartManagedConnect={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /connect claude account/i })).not.toBeInTheDocument();
    expect(screen.getByText(/rolling out/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/token/i)).toBeInTheDocument();
  });
});
