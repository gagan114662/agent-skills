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

  it("lists each agent's name, summary and capabilities", () => {
    render(<Garden data={response()} onEnable={() => {}} onDisable={() => {}} />);
    expect(screen.getByText("Scout")).toBeInTheDocument();
    expect(screen.getByText(/Audits your site/)).toBeInTheDocument();
    expect(screen.getByText("seo.audit")).toBeInTheDocument();
  });

  it("calls onEnable when a disabled read-only agent is switched on", () => {
    const onEnable = vi.fn();
    render(<Garden data={response()} onEnable={onEnable} onDisable={() => {}} />);
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
});
