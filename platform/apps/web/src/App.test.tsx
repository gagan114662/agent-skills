import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "./App.js";
import { createStore } from "./store/store.js";
import { StoreProvider } from "./store/StoreContext.js";
import { fakeRealtime, makeFakeDeps } from "./test/utils.js";
import { navigate } from "./routing.js";

const unauthorized = () => {
  throw Object.assign(new Error("unauthorized"), { status: 401 });
};

afterEach(() => {
  vi.restoreAllMocks();
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
    expect(screen.getByText("ICP")).toBeInTheDocument();
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

  it("opens the homepage dashboard as a public work-summary surface", async () => {
    navigate("/dashboard");
    const { deps } = makeFakeDeps({ me: unauthorized });
    const store = createStore({ api: deps.api, realtime: fakeRealtime() });

    render(
      <StoreProvider store={store}>
        <App />
      </StoreProvider>,
    );

    expect(await screen.findByRole("region", { name: "work summary" })).toHaveAttribute("id", "dashboard");
    expect(screen.getByText("first campaign platform")).toBeInTheDocument();
    expect(screen.queryByText(/Sign in with Google/i)).not.toBeInTheDocument();
  });
});
