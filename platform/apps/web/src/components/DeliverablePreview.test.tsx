import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DeliverablePreview } from "./DeliverablePreview.js";
import { ONBOARDING } from "../brand.js";
import type { EventSourceLike } from "../api/deliverable.js";

/**
 * #633: the live deliverable view streams a real artifact in (start → sections → done) while the parallel
 * sign-in sits beside it. A fake EventSource (jsdom has none) drives the frames so we can assert sections
 * appear, the sign-in is always reachable (config is never a gate), and a failed stream degrades honestly.
 */

class FakeEventSource implements EventSourceLike {
  url: string;
  closed = false;
  onerror: ((ev: unknown) => void) | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  listeners = new Map<string, (ev: { data: string }) => void>();
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: string, listener: (ev: { data: string }) => void): void {
    this.listeners.set(type, listener);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data: unknown): void {
    act(() => this.listeners.get(type)?.({ data: JSON.stringify(data) }));
  }
  fail(): void {
    act(() => this.onerror?.(null));
  }
}

let source: FakeEventSource | undefined;
const factory = (url: string): EventSourceLike => (source = new FakeEventSource(url));

afterEach(() => {
  source = undefined;
  vi.restoreAllMocks();
});

function renderPreview(overrides?: { onSignIn?: () => void; onRestart?: () => void }) {
  const onSignIn = overrides?.onSignIn ?? vi.fn();
  const onRestart = overrides?.onRestart ?? vi.fn();
  render(
    <DeliverablePreview url="acme.com" onSignIn={onSignIn} onRestart={onRestart} eventSourceFactory={factory} />,
  );
  return { onSignIn, onRestart };
}

describe("DeliverablePreview (#633)", () => {
  it("opens the stream for the typed url and shows a working state before any frame", () => {
    renderPreview();
    expect(source?.url).toBe("/onboarding/deliverable/stream?url=acme.com");
    expect(screen.getByRole("status")).toHaveTextContent(ONBOARDING.deliverable.working);
  });

  it("renders the header and each section as it streams in", () => {
    renderPreview();
    source!.emit("start", {
      business: { url: "https://acme.com", host: "acme.com", name: "Acme" },
      title: "Acme's first-week growth teardown",
      subtitle: "A real deliverable for acme.com",
      sectionCount: 2,
    });
    source!.emit("section", { id: "snapshot", kind: "insight", heading: "Snapshot", body: "Body one", index: 0 });
    source!.emit("section", { id: "wins", kind: "action", heading: "Quick wins", body: "Body two", index: 1 });

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Acme's first-week growth teardown");
    expect(screen.getByText("Snapshot")).toBeInTheDocument();
    expect(screen.getByText("Quick wins")).toBeInTheDocument();
    expect(screen.getByText(ONBOARDING.deliverable.kinds.insight)).toBeInTheDocument();
    expect(screen.getByText(ONBOARDING.deliverable.kinds.action)).toBeInTheDocument();
  });

  it("shows the done message and closes the source when the stream finishes", () => {
    renderPreview();
    source!.emit("section", { id: "a", kind: "draft", heading: "H", body: "B", index: 0 });
    source!.emit("done", { sectionCount: 1 });
    expect(screen.getByText(ONBOARDING.deliverable.ready)).toBeInTheDocument();
    expect(source!.closed).toBe(true);
  });

  it("keeps the sign-in reachable the whole time (config is never a gate)", async () => {
    const { onSignIn } = renderPreview();
    // Even before any artifact streams in, the parallel sign-in is present and works.
    await userEvent.click(screen.getByRole("button", { name: new RegExp(ONBOARDING.googleCta, "i") }));
    expect(onSignIn).toHaveBeenCalledOnce();
  });

  it("lets the visitor go back to try a different website", async () => {
    const { onRestart } = renderPreview();
    await userEvent.click(screen.getByRole("button", { name: new RegExp(ONBOARDING.deliverable.restart, "i") }));
    expect(onRestart).toHaveBeenCalledOnce();
  });

  it("degrades honestly when the stream fails before any section (no faked artifact)", () => {
    renderPreview();
    source!.fail();
    expect(screen.getByRole("alert")).toHaveTextContent(ONBOARDING.deliverable.error);
    // The sign-in is still offered so the visitor is never stuck.
    expect(screen.getByRole("button", { name: new RegExp(ONBOARDING.googleCta, "i") })).toBeInTheDocument();
  });
});
