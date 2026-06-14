/**
 * PeekDrawer — the v5 dive-in surface. Presentational, so these are pure prop-driven tests: the step trail
 * shows under "What it's doing", the "why?" link flips in place to the audit receipts, the Approve / Not yet
 * pair raises the parent's intent (it never decides itself — the #13 gate lives in the container), and the
 * composer sends a steer. All copy comes from brand.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PeekDrawer, type PeekAuditLine, type PeekTranscriptLine } from "./PeekDrawer.js";
import { CONSOLE } from "../../brand.js";

const TRANSCRIPT: PeekTranscriptLine[] = [
  { id: "m1", who: "Scout", body: "reading the sitemap", mine: false, hue: "#ff4524" },
  { id: "m2", who: "you", body: "focus on the pricing page", mine: true },
];
const AUDIT: PeekAuditLine[] = [
  { label: "Owner · Scout", tag: "agent" },
  { label: "Action · external.send · held for your yes", tag: "gate" },
];

function base(over: Partial<React.ComponentProps<typeof PeekDrawer>> = {}): React.ComponentProps<typeof PeekDrawer> {
  return {
    open: true,
    title: "Audit ipop.ai and file the SEO trips",
    dept: "seo",
    agent: "Scout",
    hue: "#ff4524",
    kind: "running",
    initialMode: "steps",
    transcript: TRANSCRIPT,
    audit: AUDIT,
    askLine: null,
    canCompose: true,
    canApprove: false,
    deciding: false,
    onApprove: vi.fn(),
    onReject: vi.fn(),
    onClose: vi.fn(),
    onSend: vi.fn(),
    ...over,
  };
}

describe("PeekDrawer (console v5)", () => {
  it("shows the step trail under 'What it's doing', then flips to the audit on the why link", async () => {
    render(<PeekDrawer {...base()} />);
    expect(screen.getByText(CONSOLE.peek.doing)).toBeInTheDocument();
    expect(screen.getByText("reading the sitemap")).toBeInTheDocument();
    // Audit receipts are not shown until you ask why.
    expect(screen.queryByText("Action · external.send · held for your yes")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: CONSOLE.peek.why }));
    expect(screen.getByText("Action · external.send · held for your yes")).toBeInTheDocument();
    // …and back again.
    await userEvent.click(screen.getByRole("button", { name: CONSOLE.peek.back }));
    expect(screen.getByText("reading the sitemap")).toBeInTheDocument();
  });

  it("opens straight to the audit when asked (the board 'why?' link)", () => {
    render(<PeekDrawer {...base({ initialMode: "audit" })} />);
    expect(screen.getByText("Owner · Scout")).toBeInTheDocument();
    expect(screen.queryByText(CONSOLE.peek.doing)).toBeNull();
  });

  it("shows the Approve / Not yet pair only for an approval-needed task and raises intent (never decides)", async () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(
      <PeekDrawer
        {...base({ kind: "waiting", canApprove: true, askLine: "external.send · $12.00", onApprove, onReject })}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/external\.send · \$12\.00/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: CONSOLE.peek.approve }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    await userEvent.click(within(dialog).getByRole("button", { name: CONSOLE.peek.notYet }));
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it("hides the approve pair for a running task and sends a steer through the composer", async () => {
    const onSend = vi.fn();
    render(<PeekDrawer {...base({ onSend })} />);
    expect(screen.queryByRole("button", { name: CONSOLE.peek.approve })).toBeNull();
    await userEvent.type(screen.getByLabelText(CONSOLE.peek.steerPlaceholder), "tighten the title tags");
    await userEvent.click(screen.getByRole("button", { name: CONSOLE.peek.send }));
    expect(onSend).toHaveBeenCalledWith("tighten the title tags");
  });
});
