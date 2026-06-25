import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConsoleEmptyState } from "./ConsoleEmptyState.js";

describe("ConsoleEmptyState (#917)", () => {
  it("renders an actionable activation diagnostic after seed lands but work is degraded", () => {
    render(
      <ConsoleEmptyState
        onStart={vi.fn()}
        busy={false}
        seeded={true}
        error={null}
        claudeConnected={false}
        activationDiagnostic={{
          state: "sessions_failing",
          headline: "I couldn't start up.",
          detail: "Connect Claude, then retry activation.",
          dominantFailureClass: "spawn",
          liveCount: 0,
          recentFailureCount: 1,
        }}
        coolOff={0}
        onConnect={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("I couldn't start up.")).toBeInTheDocument();
    expect(screen.getByText("Connect Claude, then retry activation.")).toBeInTheDocument();
  });

  it("routes the primary first-run action to Connect Claude before hiring (#916)", () => {
    const onStart = vi.fn();
    const onConnect = vi.fn();
    render(
      <ConsoleEmptyState
        onStart={onStart}
        busy={false}
        seeded={false}
        error={null}
        claudeConnected={false}
        coolOff={0}
        onConnect={onConnect}
        onRetry={vi.fn()}
      />,
    );

    screen.getByRole("button", { name: /connect claude first/i }).click();
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
  });
});
