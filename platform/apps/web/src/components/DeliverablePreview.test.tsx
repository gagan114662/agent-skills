import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DeliverablePreview } from "./DeliverablePreview.js";
import { ONBOARDING } from "../brand.js";
import type { DemoDeliverableDto, FetchLike } from "../api/demo.js";

/**
 * #633/#1221: the live deliverable view fetches one robust JSON artifact and reveals it section by section
 * while the parallel sign-in sits beside it. Fake fetches keep this deterministic under jsdom and prove a
 * failed build degrades honestly into a domain-only starter artifact instead of a broken first run.
 */

const PLAN: DemoDeliverableDto = {
  business: { url: "https://acme.com", host: "acme.com", name: "Acme" },
  title: "Acme's first-week growth teardown",
  subtitle: "A real deliverable for acme.com",
  sections: [
    { id: "snapshot", kind: "insight", heading: "Snapshot", body: "Body one" },
    { id: "wins", kind: "action", heading: "Quick wins", body: "Body two" },
  ],
};

function okFetch(plan: DemoDeliverableDto = PLAN, calls: string[] = []): FetchLike {
  return async (input) => {
    calls.push(input);
    return { ok: true, status: 200, json: async () => plan };
  };
}

function failingFetch(): FetchLike {
  return async () => ({ ok: false, status: 500, json: async () => ({}) });
}

function deferredFetch(calls: string[] = []): { fetchImpl: FetchLike; resolve: (plan?: DemoDeliverableDto) => void } {
  let resolve!: (plan?: DemoDeliverableDto) => void;
  const promise = new Promise<DemoDeliverableDto | undefined>((r) => {
    resolve = r;
  });
  return {
    resolve,
    fetchImpl: async (input) => {
      calls.push(input);
      const plan = await promise;
      return { ok: true, status: 200, json: async () => plan ?? PLAN };
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

function renderPreview(overrides?: {
  fetchImpl?: FetchLike;
  revealDelayMs?: number;
  onSignIn?: () => void;
  onRestart?: () => void;
}) {
  const onSignIn = overrides?.onSignIn ?? vi.fn();
  const onRestart = overrides?.onRestart ?? vi.fn();
  render(
    <DeliverablePreview
      url="acme.com"
      onSignIn={onSignIn}
      onRestart={onRestart}
      fetchImpl={overrides?.fetchImpl ?? okFetch()}
      revealDelayMs={overrides?.revealDelayMs ?? 0}
    />,
  );
  return { onSignIn, onRestart };
}

describe("DeliverablePreview (#633/#1221)", () => {
  it("fetches the single-shot deliverable for the typed url and shows a working state while pending", async () => {
    const calls: string[] = [];
    const pending = deferredFetch(calls);
    renderPreview({ fetchImpl: pending.fetchImpl });

    expect(calls).toEqual(["/onboarding/deliverable?url=acme.com"]);
    expect(screen.getByRole("status")).toHaveTextContent(ONBOARDING.deliverable.working);

    pending.resolve();
    await screen.findByRole("heading", { level: 1, name: /Acme's first-week growth teardown/i });
  });

  it("renders the header and each section from the fetched artifact", async () => {
    renderPreview();

    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(
      "Acme's first-week growth teardown",
    );
    expect(await screen.findByText("Snapshot")).toBeInTheDocument();
    expect(await screen.findByText("Quick wins")).toBeInTheDocument();
    expect(screen.getByText(ONBOARDING.deliverable.kinds.insight)).toBeInTheDocument();
    expect(screen.getByText(ONBOARDING.deliverable.kinds.action)).toBeInTheDocument();
  });

  it("shows the done message after the fetched sections are revealed", async () => {
    renderPreview();
    await screen.findByText(ONBOARDING.deliverable.ready);
  });

  it("keeps the sign-in reachable the whole time (config is never a gate)", async () => {
    const { onSignIn } = renderPreview();
    await userEvent.click(screen.getByRole("button", { name: new RegExp(ONBOARDING.googleCta, "i") }));
    expect(onSignIn).toHaveBeenCalledOnce();
  });

  it("lets the visitor go back to try a different website", async () => {
    const { onRestart } = renderPreview();
    await userEvent.click(screen.getByRole("button", { name: new RegExp(ONBOARDING.deliverable.restart, "i") }));
    expect(onRestart).toHaveBeenCalledOnce();
  });

  it("degrades honestly when the preview fetch fails before any section", async () => {
    renderPreview({ fetchImpl: failingFetch() });
    expect(await screen.findByRole("heading", { level: 1, name: /acme\.com starter growth brief/i })).toBeInTheDocument();
    expect(await screen.findByText("What we can use immediately")).toBeInTheDocument();
    expect(await screen.findByText(/limited to the submitted domain/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: new RegExp(ONBOARDING.googleCta, "i") })).toBeInTheDocument();
  });

  it("paces section reveal locally after the full artifact is fetched", async () => {
    renderPreview({ revealDelayMs: 10 });
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByText("Snapshot")).not.toBeInTheDocument();

    expect(await screen.findByText("Snapshot")).toBeInTheDocument();
    expect(await screen.findByText("Quick wins")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(ONBOARDING.deliverable.ready)).toBeInTheDocument());
  });
});
