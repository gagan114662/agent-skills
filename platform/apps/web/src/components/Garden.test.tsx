import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Garden } from "./Garden.js";
import { GARDEN } from "../brand.js";
import type { GardenAgentView, GardenResponse } from "../api/types.js";

function agent(over: Partial<GardenAgentView>): GardenAgentView {
  return {
    handle: "scout",
    displayName: "Scout",
    title: "SEO",
    summary: "Audits your site the way a crawler does.",
    capabilities: ["seo.audit"],
    costTier: "medium",
    riskTier: "read_only",
    priceLabel: "Standard compute",
    requiresApprovalToEnable: false,
    present: true,
    state: "disabled",
    active: false,
    inactiveReason: "Off — switch it on to put it to work.",
    ...over,
  };
}

function response(over: Partial<GardenResponse> = {}): GardenResponse {
  return { canManage: true, agents: [agent({})], ...over };
}

describe("Garden (pure)", () => {
  it("shows a loading state until the data arrives", () => {
    render(<Garden data={null} onEnable={() => {}} onDisable={() => {}} />);
    expect(screen.getByText(GARDEN.loading)).toBeInTheDocument();
  });

  it("lists each agent's name, summary and human-readable capabilities (never raw ids)", () => {
    render(<Garden data={response()} onEnable={() => {}} onDisable={() => {}} />);
    expect(screen.getByText("Scout")).toBeInTheDocument();
    expect(screen.getByText(/Audits your site/)).toBeInTheDocument();
    // The card shows the human-readable capability name, not the developer id the server ships.
    expect(screen.getByText("Audit")).toBeInTheDocument();
    expect(screen.queryByText("seo.audit")).toBeNull();
  });

  it("humanizes multi-word and acronym capability ids", () => {
    const data = response({
      agents: [agent({ capabilities: ["social.draft_thread", "reach.build_icp"] })],
    });
    render(<Garden data={data} onEnable={() => {}} onDisable={() => {}} />);
    expect(screen.getByText("Draft thread")).toBeInTheDocument();
    expect(screen.getByText("Build ICP")).toBeInTheDocument();
    expect(screen.queryByText("social.draft_thread")).toBeNull();
  });

  it("never renders the server's raw off reason ('switch it on to work')", () => {
    // An explicitly opted-out capability is the only one that reads as Off (default is ON, #760).
    const data = response({ agents: [agent({ userPreference: "off" })] });
    render(<Garden data={data} onEnable={() => {}} onDisable={() => {}} />);
    expect(screen.queryByText(/switch it on/i)).toBeNull();
    // The off state reads as a calm, designed label instead.
    expect(screen.getByText(GARDEN.off)).toBeInTheDocument();
  });

  it("flags an outbound agent as money-gated", () => {
    const data = response({
      agents: [agent({ riskTier: "external_send", requiresApprovalToEnable: true })],
    });
    render(<Garden data={data} onEnable={() => {}} onDisable={() => {}} />);
    expect(screen.getByText(GARDEN.moneyGated)).toBeInTheDocument();
  });

  it("calls onEnable when an opted-out read-only agent is switched back on", () => {
    const onEnable = vi.fn();
    // Default is ON, so the switch-ON control only appears for a capability the owner deliberately turned off.
    const data = response({ agents: [agent({ userPreference: "off" })] });
    render(<Garden data={data} onEnable={onEnable} onDisable={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(GARDEN.enable) }));
    expect(onEnable).toHaveBeenCalledWith("scout");
  });

  it("an external-send agent's switch-on control shows it needs approval", () => {
    const data = response({
      agents: [agent({ handle: "echo", displayName: "Echo", riskTier: "external_send", requiresApprovalToEnable: true })],
    });
    render(<Garden data={data} onEnable={() => {}} onDisable={() => {}} />);
    expect(screen.getByText(new RegExp(GARDEN.needsApproval))).toBeInTheDocument();
  });

  it("a pending_approval agent reads as awaiting approval and offers switch-off", () => {
    const onDisable = vi.fn();
    const data = response({
      agents: [agent({ handle: "echo", displayName: "Echo", state: "pending_approval", riskTier: "external_send", requiresApprovalToEnable: true })],
    });
    render(<Garden data={data} onEnable={() => {}} onDisable={onDisable} />);
    expect(screen.getByText(GARDEN.pending)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: GARDEN.disable }));
    expect(onDisable).toHaveBeenCalledWith("echo");
  });

  it("an active agent shows the On badge and a switch-off control", () => {
    render(
      <Garden
        data={response({ agents: [agent({ state: "enabled", active: true, inactiveReason: null })] })}
        onEnable={() => {}}
        onDisable={() => {}}
      />,
    );
    expect(screen.getByText(GARDEN.on)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: GARDEN.disable })).toBeInTheDocument();
  });

  it("when the surface can't be managed, it shows the rollout note and no toggle buttons", () => {
    render(
      <Garden
        data={response({ canManage: false })}
        onEnable={() => {}}
        onDisable={() => {}}
      />,
    );
    expect(screen.getByText(GARDEN.rollout)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders an error when one is passed", () => {
    render(<Garden data={response()} error={GARDEN.error} onEnable={() => {}} onDisable={() => {}} />);
    expect(screen.getByRole("alert")).toHaveTextContent(GARDEN.error);
  });

  // --- Autonomy by default / opt-out (#760) --------------------------------------------------------------

  it("defaults a non-money capability ON when no preference is stored, offering switch-off", () => {
    // A fresh workspace: server reports `disabled` (no stored row), no explicit preference.
    const onDisable = vi.fn();
    const data = response({ agents: [agent({ state: "disabled", active: false, userPreference: undefined })] });
    render(<Garden data={data} onEnable={() => {}} onDisable={onDisable} />);
    // It reads as ON, not Off — the opt-out promise.
    expect(screen.getByText(GARDEN.on)).toBeInTheDocument();
    expect(screen.queryByText(GARDEN.off)).toBeNull();
    // And the only control offered is to switch it OFF (you opt out), which persists the choice.
    const toggle = screen.getByRole("button", { name: GARDEN.disable });
    fireEvent.click(toggle);
    expect(onDisable).toHaveBeenCalledWith("scout");
  });

  it("respects a persisted OFF preference even though the default is ON", () => {
    const data = response({ agents: [agent({ userPreference: "off" })] });
    render(<Garden data={data} onEnable={() => {}} onDisable={() => {}} />);
    expect(screen.getByText(GARDEN.off)).toBeInTheDocument();
    expect(screen.queryByText(GARDEN.on)).toBeNull();
    // The control offered is to switch it back on (no off-switch for an already-off capability).
    expect(screen.getByRole("button", { name: new RegExp(GARDEN.enable) })).toBeInTheDocument();
  });

  it("presents a money-gated capability ON-but-approval-gated by default (never auto-spend)", () => {
    const data = response({
      agents: [
        agent({
          handle: "echo",
          displayName: "Echo",
          riskTier: "external_send",
          requiresApprovalToEnable: true,
          state: "disabled",
          active: false,
          userPreference: undefined,
        }),
      ],
    });
    render(<Garden data={data} onEnable={() => {}} onDisable={() => {}} />);
    // ON (working), with the money-gated + needs-approval badges intact.
    expect(screen.getByText(GARDEN.on)).toBeInTheDocument();
    expect(screen.getByText(GARDEN.moneyGated)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(GARDEN.needsApproval))).toBeInTheDocument();
  });

  it("the opt-out copy reads as 'switch off what you don't want', never 'switch on the ones you want'", () => {
    render(<Garden data={response()} onEnable={() => {}} onDisable={() => {}} />);
    expect(screen.getByText(/switch off/i)).toBeInTheDocument();
    expect(screen.queryByText(/switch on the ones you want/i)).toBeNull();
  });
});
