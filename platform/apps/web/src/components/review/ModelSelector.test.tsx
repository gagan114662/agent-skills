import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { AgentSessionSummary, ModelSelection } from "../../api/types.js";
import { ModelSelector, ModelBadge, DEFAULT_SELECTION } from "./ModelSelector.js";

/** The model/provider/effort/Auto selection control (#52) — a fully-controlled widget. */
describe("ModelSelector", () => {
  it("emits provider/effort changes through onChange", () => {
    const onChange = vi.fn();
    const { getByLabelText } = render(<ModelSelector value={DEFAULT_SELECTION} onChange={onChange} />);
    fireEvent.change(getByLabelText("Provider"), { target: { value: "bedrock" } });
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SELECTION, provider: "bedrock" });
    fireEvent.change(getByLabelText("Effort"), { target: { value: "high" } });
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SELECTION, effort: "high" });
  });

  it("toggling Auto switches mode and disables the model input", () => {
    const onChange = vi.fn();
    const auto: ModelSelection = { ...DEFAULT_SELECTION, mode: "auto" };
    const { getByLabelText, rerender } = render(
      <ModelSelector value={DEFAULT_SELECTION} onChange={onChange} />,
    );
    fireEvent.click(getByLabelText("Auto mode"));
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_SELECTION, mode: "auto" });
    rerender(<ModelSelector value={auto} onChange={onChange} />);
    expect(getByLabelText("Model")).toBeDisabled();
  });
});

describe("ModelBadge", () => {
  const base: AgentSessionSummary = {
    id: "s1",
    channelId: "c1",
    agentMemberId: "ag1",
    status: "completed",
    result: null,
    branch: null,
    baseBranch: null,
    headSha: null,
    provider: null,
    model: null,
    effort: null,
    mode: null,
    createdAt: "2026-06-09T00:00:00.000Z",
  };

  it("renders nothing when no selection was recorded", () => {
    const { container } = render(<ModelBadge session={base} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows provider · model (+ auto, + effort) when present", () => {
    const { getByTitle } = render(
      <ModelBadge
        session={{ ...base, provider: "bedrock", model: "claude-sonnet-4-6", mode: "auto", effort: "high" }}
      />,
    );
    const badge = getByTitle("Model / provider selection");
    expect(badge.textContent).toContain("bedrock · claude-sonnet-4-6");
    expect(badge.textContent).toContain("auto");
    expect(badge.textContent).toContain("high");
  });
});
