import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../App.js";
import { api } from "../api/client.js";
import { createStore } from "../store/store.js";
import { StoreProvider } from "../store/StoreContext.js";
import { fakeRealtime } from "../test/utils.js";

/**
 * Reproduces #108: when the web console is deployed with no backend (Vercel SPA, API not wired),
 * the SPA rewrite serves `index.html` (HTTP 200, text/html) for every API path — `/me`,
 * `/workspaces/.../channels`, … The old client handed that HTML string straight to the store, so a
 * component rendered `channels.filter(...)` on a string and crashed with
 * "TypeError: i.filter is not a function", leaving a blank dark page.
 */
function stubHtmlFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response('<!doctype html><html><body><div id="root"></div></body></html>', {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.pushState({}, "", "/");
});

describe("web console with no API backend", () => {
  it("renders a clear 'API not connected' state instead of crashing", async () => {
    stubHtmlFetch();
    // #784: root `/` (and `/welcome`) now open the public onboarding door, which needs no backend. This test
    // exercises the AUTHED app's offline fallback, so it must render at a real signed-in product route.
    window.history.pushState({}, "", "/everyday");
    const store = createStore({ api, realtime: fakeRealtime() });

    render(
      <StoreProvider store={store}>
        <App />
      </StoreProvider>,
    );

    // The friendly fallback renders (no thrown render error) and we never entered the workspace.
    // Copy carries the #138 house voice ("can't reach the back office").
    expect(await screen.findByText(/back office/i)).toBeInTheDocument();
    expect(store.getState().phase).toBe("offline");
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
  });
});
