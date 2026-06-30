import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App.js";
import { createStore } from "./store/store.js";
import { StoreProvider } from "./store/StoreContext.js";
import { fakeRealtime, makeFakeDeps } from "./test/utils.js";
import { navigate } from "./routing.js";
import { api } from "./api/client.js";
import { FIRST_RUN_RECEIPT_KEY } from "./components/onboarding/first-run-receipt.js";

const unauthorized = () => {
  throw Object.assign(new Error("unauthorized"), { status: 401 });
};

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  window.history.pushState({}, "", "/");
});

describe("App root routing", () => {
  it("shows the public onboarding door at / for logged-out visitors", async () => {
    const { deps } = makeFakeDeps({ me: unauthorized });
    const store = createStore({ api: deps.api, realtime: fakeRealtime() });

    render(
      <StoreProvider store={store}>
        <App />
      </StoreProvider>,
    );

    expect(await screen.findByLabelText(/what are we marketing today/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "iMessage room" })).not.toBeInTheDocument();
  });

  it("shows the marketing-icon front door at / for signed-in visitors too", async () => {
    const { deps } = makeFakeDeps();
    const store = createStore({ api: deps.api, realtime: fakeRealtime() });

    render(
      <StoreProvider store={store}>
        <App />
      </StoreProvider>,
    );

    expect(await screen.findByLabelText(/what are we marketing today/i)).toBeInTheDocument();
    expect(screen.getByText("brief")).toBeInTheDocument();
    expect(screen.getByText("ICP folder")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "iMessage room" })).not.toBeInTheDocument();
  });

  it("keeps /welcome on the same marketing-icon front door", async () => {
    navigate("/welcome");
    const { deps } = makeFakeDeps();
    const store = createStore({ api: deps.api, realtime: fakeRealtime() });

    render(
      <StoreProvider store={store}>
        <App />
      </StoreProvider>,
    );

    expect(await screen.findByLabelText(/what are we marketing today/i)).toBeInTheDocument();
    expect(screen.getByText("customer")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "iMessage room" })).not.toBeInTheDocument();
  });

  it("keeps /everyday as the direct signed-in iMessage agent room", async () => {
    navigate("/everyday");
    const { deps } = makeFakeDeps();
    const store = createStore({ api: deps.api, realtime: fakeRealtime() });

    render(
      <StoreProvider store={store}>
        <App />
      </StoreProvider>,
    );

    expect(await screen.findByRole("heading", { name: "iMessage room" })).toBeInTheDocument();
  });

  it("opens /signup as the real signup form for logged-out visitors (#1457)", async () => {
    navigate("/signup");
    const { deps } = makeFakeDeps({ me: unauthorized });
    const store = createStore({ api: deps.api, realtime: fakeRealtime() });

    render(
      <StoreProvider store={store}>
        <App />
      </StoreProvider>,
    );

    expect(await screen.findByRole("button", { name: /create account/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/display name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/workspace/i)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "CMO brief" })).not.toBeInTheDocument();
  });

  it("opens /login as the real sign-in form for logged-out visitors (#1459)", async () => {
    navigate("/login");
    const { deps } = makeFakeDeps({ me: unauthorized });
    const store = createStore({ api: deps.api, realtime: fakeRealtime() });

    render(
      <StoreProvider store={store}>
        <App />
      </StoreProvider>,
    );

    expect(await screen.findByRole("button", { name: /sign in/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "CMO brief" })).not.toBeInTheDocument();
  });

  it("opens the homepage dashboard as a public CMO brief surface", async () => {
    await act(async () => {
      navigate("/dashboard");
    });
    const { deps } = makeFakeDeps({ me: unauthorized });
    const store = createStore({ api: deps.api, realtime: fakeRealtime() });

    render(
      <StoreProvider store={store}>
        <App />
      </StoreProvider>,
    );

    expect(await screen.findByRole("region", { name: "CMO brief" })).toHaveAttribute(
      "id",
      "dashboard",
    );
    expect(screen.queryByRole("heading", { name: "iMessage room" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Connect accounts" })).not.toBeInTheDocument();
    expect(screen.getByText("sample readout")).toBeInTheDocument();
    expect(screen.getByText("leads found")).toBeInTheDocument();
    expect(screen.getByText("channel performance")).toBeInTheDocument();
    expect(screen.getAllByText("PR #1276").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Sign in with Google/i)).not.toBeInTheDocument();
  });

  it("opens /dashboard with live workspace data for signed-in users instead of dogfood copy", async () => {
    await act(async () => {
      navigate("/dashboard");
    });
    const { deps } = makeFakeDeps();
    const store = createStore({ api: deps.api, realtime: fakeRealtime() });

    render(
      <StoreProvider store={store}>
        <App />
      </StoreProvider>,
    );

    const dashboard = await screen.findByRole("region", { name: "CMO brief" });
    expect(dashboard).toHaveAttribute("id", "dashboard");
    expect(screen.queryByRole("heading", { name: "iMessage room" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Connect accounts" })).not.toBeInTheDocument();
    expect(screen.getByText("live workspace")).toBeInTheDocument();
    expect(screen.getByText(/no prospect source connected/i)).toBeInTheDocument();
    expect(screen.queryByText("PR #1276")).not.toBeInTheDocument();
  });

  it("carries public first-run agent output into the signed-in dashboard receipt (#1289)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        business: { host: "acme.com", name: "Acme" },
        title: "Acme first-week growth teardown",
        subtitle: "A sharper promise is hiding below the fold.",
        sections: [
          {
            id: "insight",
            kind: "insight",
            heading: "Customer truth",
            body: "your hero buries the offer below the fold.",
          },
          {
            id: "action",
            kind: "action",
            heading: "Next move",
            body: "rewrite the hero and queue a launch-week post plan.",
          },
        ],
      }),
    } as Response);
    vi.spyOn(api, "getConnections").mockResolvedValue({
      connections: [],
      canManageInternal: false,
    });
    vi.spyOn(api.department, "seed").mockResolvedValue({
      channels: [],
      agents: [],
      welcomeTasks: [],
    });
    vi.spyOn(api.department, "brief").mockResolvedValue({
      lead: "scout",
      department: "growth",
      channelId: "c1",
      messageId: "m-brief",
      launched: [],
      connectPrompted: [],
    });
    const recordFirstRun = vi
      .spyOn(api, "recordFirstRunReceipt")
      .mockImplementation(async (input) => ({
        firstRun: {
          stage: input.stage ?? "agent_result",
          target: input.target,
          finding: input.finding,
          artifactTitle: input.artifactTitle,
          artifactSummary: input.artifactSummary,
          receipt: input.receipt,
          recordedAtMs: Date.UTC(2026, 5, 26, 18, 0),
        },
      }));
    vi.spyOn(api, "getFirstRunReceipt").mockResolvedValue({ firstRun: null });
    const { deps } = makeFakeDeps();
    const store = createStore({ api: deps.api, realtime: fakeRealtime() });

    render(
      <StoreProvider store={store}>
        <App />
      </StoreProvider>,
    );

    await act(async () => {
      fireEvent.change(await screen.findByLabelText(/what are we marketing today/i), {
        target: { value: "acme.com" },
      });
      fireEvent.click(screen.getByRole("button", { name: /start/i }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      await screen.findByRole("article", { name: /instant personalized deliverable/i }),
    ).toBeInTheDocument();
    expect(JSON.parse(window.sessionStorage.getItem(FIRST_RUN_RECEIPT_KEY) ?? "{}")).toMatchObject({
      stage: "agent_result",
      target: "acme.com",
      finding: "your hero buries the offer below the fold.",
      artifactTitle: "site-read receipt",
      artifactSummary: "your hero buries the offer below the fold.",
      receipt: "send/spend gates active",
    });

    navigate("/dashboard");

    await waitFor(() =>
      expect(recordFirstRun).toHaveBeenCalledWith({
        stage: "agent_result",
        target: "acme.com",
        finding: "your hero buries the offer below the fold.",
        artifactTitle: "site-read receipt",
        artifactSummary: "your hero buries the offer below the fold.",
        receipt: "send/spend gates active",
      }),
    );
    await waitFor(() => expect(window.sessionStorage.getItem(FIRST_RUN_RECEIPT_KEY)).toBeNull());
    expect(await screen.findByRole("region", { name: "CMO brief" })).toHaveAttribute(
      "id",
      "dashboard",
    );
    expect(screen.getByText("live workspace")).toBeInTheDocument();
    expect(
      (await screen.findAllByText("your hero buries the offer below the fold.")).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("recorded first result for acme.com").length).toBeGreaterThan(0);
    expect(screen.getAllByText("send/spend gates active").length).toBeGreaterThan(0);
  });
});
