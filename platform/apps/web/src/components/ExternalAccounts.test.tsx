import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ExternalAccounts } from "./ExternalAccounts.js";
import type { ExternalAccountsChecklist } from "../api/types.js";

/**
 * #192/#231 — Connect external accounts settings panel (presentational). The owner connects the
 * venture-operating accounts the fleet acts through; the panel shows what's still needed for real work,
 * what's connected, and a masked connect form.
 */
const EMPTY: ExternalAccountsChecklist = { requests: [], pendingSetupCount: 0 };

describe("ExternalAccounts (#231)", () => {
  it("shows a loading state until the checklist arrives", () => {
    render(<ExternalAccounts checklist={null} needed={[]} onConnect={() => {}} onDisconnect={() => {}} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("surfaces exactly which account kinds are still needed for real work", () => {
    render(
      <ExternalAccounts
        checklist={EMPTY}
        needed={["hosting", "esp"]}
        onConnect={() => {}}
        onDisconnect={() => {}}
      />,
    );
    const needed = screen.getByText(/to do real work, connect/i).closest("div") as HTMLElement;
    expect(needed).toBeInTheDocument();
    expect(within(needed).getByText(/hosting \/ publishing/i)).toBeInTheDocument();
    expect(within(needed).getByText(/email sending/i)).toBeInTheDocument();
  });

  it("shows the all-connected state when nothing is needed", () => {
    render(<ExternalAccounts checklist={EMPTY} needed={[]} onConnect={() => {}} onDisconnect={() => {}} />);
    expect(screen.getByText(/all set/i)).toBeInTheDocument();
  });

  it("#872: warns when publishing is configured as dry-run, not live", () => {
    render(
      <ExternalAccounts
        checklist={EMPTY}
        needed={[]}
        publishStatus={{ provider: "dryrun", live: false, dryRun: true }}
        onConnect={() => {}}
        onDisconnect={() => {}}
      />,
    );
    expect(screen.getByText(/publishing is in dry-run/i)).toBeInTheDocument();
    expect(screen.getByText(/dryrun.reload.app/i)).toBeInTheDocument();
  });

  it("disables Connect until a name and a masked secret are entered, then calls onConnect", () => {
    const onConnect = vi.fn();
    render(<ExternalAccounts checklist={EMPTY} needed={["hosting"]} onConnect={onConnect} onDisconnect={() => {}} />);
    const button = () => screen.getByRole("button", { name: /^connect$/i });
    expect(button()).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/account type/i), { target: { value: "hosting" } });
    fireEvent.change(screen.getByLabelText(/account name/i), { target: { value: "vercel-prod" } });
    expect((screen.getByLabelText(/key or token/i) as HTMLInputElement).type).toBe("password");
    fireEvent.change(screen.getByLabelText(/key or token/i), { target: { value: "tok-123" } });
    expect(button()).not.toBeDisabled();
    fireEvent.click(button());
    expect(onConnect).toHaveBeenCalledWith(
      expect.objectContaining({ serviceKind: "hosting", serviceKey: "vercel-prod", secret: "tok-123" }),
    );
  });

  it("#263: keeps the key/token field behind a collapsed Advanced disclosure (no default free-text secret)", () => {
    render(<ExternalAccounts checklist={EMPTY} needed={[]} onConnect={() => {}} onDisconnect={() => {}} />);
    const details = (screen.getByLabelText(/key or token/i).closest("details")) as HTMLDetailsElement | null;
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
  });

  it("lists a connected account with a disconnect action", () => {
    const onDisconnect = vi.fn();
    const checklist: ExternalAccountsChecklist = {
      requests: [
        {
          serviceKey: "vercel-prod",
          displayName: "Hosting / publishing (vercel-prod)",
          serviceKind: "hosting",
          reason: "x",
          status: "connected",
          connected: true,
        },
      ],
      pendingSetupCount: 0,
    };
    render(<ExternalAccounts checklist={checklist} needed={[]} onConnect={() => {}} onDisconnect={onDisconnect} />);
    expect(screen.getByText(/vercel-prod/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    expect(onDisconnect).toHaveBeenCalledWith("vercel-prod");
  });
});
