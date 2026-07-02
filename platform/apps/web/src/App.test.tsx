import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "./App.js";
import { createStore } from "./store/store.js";
import { StoreProvider } from "./store/StoreContext.js";
import { fakeRealtime, makeFakeDeps } from "./test/utils.js";
import { APP_ROUTES, navigate } from "./routing.js";
import { TELEGRAM_BOT_URL } from "./components/onboarding/messaging-entry.js";
import { PRICING } from "./brand.js";
import { IPOP_PUBLIC_THEME } from "./design/public-theme.js";

const unauthorized = () => {
  throw Object.assign(new Error("unauthorized"), { status: 401 });
};

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  window.history.pushState({}, "", "/");
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-public-surface");
  document.body.removeAttribute("data-public-surface");
  document.body.style.backgroundColor = "";
  document.body.style.color = "";
});

const DARK_BODY_RGB = "rgb(13, 13, 17)";
const PUBLIC_BODY_RGB = "rgb(246, 241, 231)";

function forceDarkDocument(): void {
  document.documentElement.setAttribute("data-theme", "reload-dark");
  document.body.style.backgroundColor = DARK_BODY_RGB;
  document.body.style.color = "rgb(243, 243, 246)";
}

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
    expect(screen.getByRole("textbox", { name: /what are we marketing/i })).toBeInTheDocument();
  });

  it("keeps the signed-in /everyday room on the warm homepage background, not reload-dark (#1532)", async () => {
    navigate("/everyday");
    forceDarkDocument();
    const { deps } = makeFakeDeps();
    const store = createStore({ api: deps.api, realtime: fakeRealtime() });

    render(
      <StoreProvider store={store}>
        <App />
      </StoreProvider>,
    );

    await screen.findByRole("heading", { name: "iMessage room" });
    await waitFor(() => {
      expect(document.body).toHaveAttribute("data-public-surface", "light");
      expect(getComputedStyle(document.body).backgroundColor).toBe(PUBLIC_BODY_RGB);
    });
    expect(getComputedStyle(document.body).backgroundColor).not.toBe(DARK_BODY_RGB);
    const shell = document.querySelector<HTMLElement>(".everyday-shell");
    expect(shell).toHaveClass("everyday-shell--public");
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
    expect(screen.queryByRole("region", { name: "Marketing dashboard" })).not.toBeInTheDocument();
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
    expect(screen.queryByRole("region", { name: "Marketing dashboard" })).not.toBeInTheDocument();
  });

  it("opens direct /pricing as the public pricing page instead of the branded 404 (#1482)", async () => {
    navigate("/pricing");
    const { deps } = makeFakeDeps({ me: unauthorized });
    const store = createStore({ api: deps.api, realtime: fakeRealtime() });

    render(
      <StoreProvider store={store}>
        <App />
      </StoreProvider>,
    );

    expect(await screen.findByRole("heading", { name: PRICING.title })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "homepage actions" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Page not found" })).not.toBeInTheDocument();
  });

  it("navigates from a /pricing plan CTA to the real signup form, never the workspace room (#1489)", async () => {
    navigate("/pricing");
    const { deps } = makeFakeDeps({ me: unauthorized });
    const store = createStore({ api: deps.api, realtime: fakeRealtime() });

    render(
      <StoreProvider store={store}>
        <App />
      </StoreProvider>,
    );

    // The public pricing page renders with one CTA per plan.
    await screen.findByRole("heading", { name: PRICING.title });
    const proCta = screen.getByRole("link", {
      name: (name) =>
        name.toLowerCase().includes(PRICING.planCta.toLowerCase()) &&
        name.toLowerCase().includes("pro"),
    });

    // #1489 root cause guard: the plan CTA must be a browser-native anchor pointing straight at the
    // plan's signup URL — a full navigation the browser always performs. It must NOT be a client-side
    // handler that can preventDefault the click and strand a buyer on /pricing (the reported dead end).
    expect(proCta.tagName).toBe("A");
    expect(proCta).toHaveAttribute("href", "/signup?plan=pro&billing=month");
    // fireEvent.click returns false only when a handler cancelled the event (called preventDefault);
    // true proves nothing swallowed the click, so the browser follows the href.
    expect(fireEvent.click(proCta)).toBe(true);

    // Following that href through the real App + AuthGate lands a logged-out buyer on the account form —
    // the create-account fields with the chosen plan framed, never the iMessage workspace room the bug
    // fell through to.
    await act(async () => {
      navigate("/signup?plan=pro&billing=month");
    });
    expect(await screen.findByRole("button", { name: /create account/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/display name/i)).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(PRICING.trial.onPlan("Pro"));
    expect(screen.queryByRole("heading", { name: "iMessage room" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Marketing dashboard" })).not.toBeInTheDocument();
  });

  it.each([
    { path: "/demo", selector: ".demo" },
    { path: "/pricing", selector: ".pricing-page" },
    { path: "/company", selector: ".landing" },
    { path: "/terms", selector: ".landing" },
    { path: "/privacy", selector: ".landing" },
    { path: "/everyday", selector: ".onboard" },
  ])("keeps $path on the homepage light background token (#1532)", async ({ path, selector }) => {
    await act(async () => {
      navigate(path);
    });
    forceDarkDocument();
    const { deps } = makeFakeDeps({ me: unauthorized });
    const store = createStore({ api: deps.api, realtime: fakeRealtime() });

    render(
      <StoreProvider store={store}>
        <App />
      </StoreProvider>,
    );

    await waitFor(() => {
      expect(document.body).toHaveAttribute("data-public-surface", "light");
      expect(getComputedStyle(document.body).backgroundColor).toBe(PUBLIC_BODY_RGB);
    });
    expect(getComputedStyle(document.body).backgroundColor).not.toBe(DARK_BODY_RGB);

    await waitFor(() => {
      const root = document.querySelector<HTMLElement>(selector);
      expect(root).not.toBeNull();
      expect(getComputedStyle(root!).backgroundColor).toBe(PUBLIC_BODY_RGB);
      expect(getComputedStyle(root!).backgroundColor).not.toBe(DARK_BODY_RGB);
    });
    expect(IPOP_PUBLIC_THEME.bg).toBe("#f6f1e7");
  });

  it("opens direct /start as the public homepage flow instead of the branded 404 (#1482)", async () => {
    navigate("/start");
    const { deps } = makeFakeDeps({ me: unauthorized });
    const store = createStore({ api: deps.api, realtime: fakeRealtime() });

    render(
      <StoreProvider store={store}>
        <App />
      </StoreProvider>,
    );

    expect(await screen.findByLabelText(/what are we marketing today/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Page not found" })).not.toBeInTheDocument();
  });

  it("renders a branded not-found page for unknown routes instead of the app shell (#1458)", async () => {
    navigate("/this-route-does-not-exist-qa");
    const { deps } = makeFakeDeps();
    const store = createStore({ api: deps.api, realtime: fakeRealtime() });

    render(
      <StoreProvider store={store}>
        <App />
      </StoreProvider>,
    );

    expect(screen.getByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByText("404")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go home" })).toHaveAttribute("href", APP_ROUTES.home);
    expect(screen.getByRole("link", { name: "Start" })).toHaveAttribute("href", "/start");
    expect(screen.queryByRole("heading", { name: "iMessage room" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Marketing dashboard" })).not.toBeInTheDocument();
  });

  it("opens the homepage dashboard as a public marketing dashboard surface", async () => {
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

    expect(await screen.findByRole("region", { name: "Marketing dashboard" })).toHaveAttribute(
      "id",
      "dashboard",
    );
    expect(screen.getByRole("heading", { name: "Marketing dashboard", level: 1 })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "homepage actions" });
    expect(within(nav).getByRole("link", { name: "Login" })).toHaveAttribute(
      "href",
      "/login?return=%2Feveryday",
    );
    expect(within(nav).getByRole("link", { name: "Love: watch a demo" })).toHaveAttribute(
      "href",
      "/demo",
    );
    expect(within(nav).getByRole("link", { name: "Start" })).toHaveAttribute(
      "href",
      TELEGRAM_BOT_URL,
    );
    expect(screen.queryByRole("heading", { name: "iMessage room" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Connect accounts" })).not.toBeInTheDocument();
    expect(screen.getByText("live workspace")).toBeInTheDocument();
    expect(screen.getByText("leads found")).toBeInTheDocument();
    expect(screen.getByText("where customers can come from")).toBeInTheDocument();
    expect(screen.queryByText("PR #1276")).not.toBeInTheDocument();
    expect(screen.queryByText(/Sign in with Google/i)).not.toBeInTheDocument();
    const footer = screen.getByRole("navigation", { name: "Public footer" });
    expect(within(footer).getByRole("link", { name: "Demo" })).toHaveAttribute("href", "/demo");
    expect(within(footer).getByRole("link", { name: "Pricing" })).toHaveAttribute("href", "/pricing");
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

    const dashboard = await screen.findByRole("region", { name: "Marketing dashboard" });
    expect(dashboard).toHaveAttribute("id", "dashboard");
    expect(screen.getByRole("heading", { name: "Marketing dashboard", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "homepage actions" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "iMessage room" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Connect accounts" })).not.toBeInTheDocument();
    expect(screen.getByText("live workspace")).toBeInTheDocument();
    expect(screen.getByText(/no prospect source connected/i)).toBeInTheDocument();
    expect(screen.queryByText("PR #1276")).not.toBeInTheDocument();
  });

  it("opens Telegram from the public front door instead of running the old web-first demo", async () => {
    const originalLocation = window.location;
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, assign },
    });
    const { deps } = makeFakeDeps();
    const store = createStore({ api: deps.api, realtime: fakeRealtime() });

    try {
      render(
        <StoreProvider store={store}>
          <App />
        </StoreProvider>,
      );

      fireEvent.change(await screen.findByLabelText(/what are we marketing today/i), {
        target: { value: "acme.com" },
      });
      fireEvent.click(screen.getByRole("button", { name: /open telegram/i }));

      expect(assign).toHaveBeenCalledWith(TELEGRAM_BOT_URL);
      expect(
        screen.queryByRole("article", { name: /instant personalized deliverable/i }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/recorded first result for acme.com/i)).not.toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });
});
