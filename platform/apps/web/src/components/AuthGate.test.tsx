import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthGate } from "./AuthGate.js";
import { navigate } from "../routing.js";
import { COMPANY, LEGAL, PRICING } from "../brand.js";
import { TEST_IDENTITY, renderWithStore } from "../test/utils.js";
import { api } from "../api/client.js";

const unauthorized = () => {
  throw Object.assign(new Error("unauthorized"), { status: 401 });
};

async function acceptSignupTerms(): Promise<void> {
  await userEvent.click(screen.getByRole("checkbox", { name: /agree to the terms/i }));
}

afterEach(() => {
  vi.restoreAllMocks();
  act(() => navigate("/")); // reset the route (and clear ?plan) between tests
  window.sessionStorage.clear();
});

describe("AuthGate routing", () => {
  it("shows the public landing (not the login form) for a logged-out visitor at /", async () => {
    act(() => navigate("/"));
    renderWithStore(
      <AuthGate>
        <div>WORKSPACE CONTENT</div>
      </AuthGate>,
      { me: unauthorized },
    );

    // The landing is code-split, so wait for it; the login form must NOT be on screen.
    expect(await screen.findByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(screen.queryByText("WORKSPACE CONTENT")).not.toBeInTheDocument();
  });

  it("uses the public entry at / for logged-out visitors without hiding the signed-in app", async () => {
    act(() => navigate("/"));
    const { unmount } = renderWithStore(
      <AuthGate publicEntry={<div>PUBLIC FIRST-RUN DOOR</div>}>
        <div>WORKSPACE CONTENT</div>
      </AuthGate>,
      { me: unauthorized },
    );

    expect(await screen.findByText("PUBLIC FIRST-RUN DOOR")).toBeInTheDocument();
    expect(screen.queryByText("WORKSPACE CONTENT")).not.toBeInTheDocument();

    unmount();
    renderWithStore(
      <AuthGate publicEntry={<div>PUBLIC FIRST-RUN DOOR</div>}>
        <div>WORKSPACE CONTENT</div>
      </AuthGate>,
    );

    expect(await screen.findByText("WORKSPACE CONTENT")).toBeInTheDocument();
    expect(screen.queryByText("PUBLIC FIRST-RUN DOOR")).not.toBeInTheDocument();
  });

  it("shows the sign-in form at /login, then renders the app after a successful login", async () => {
    act(() => navigate("/login"));
    let calls = 0;
    const me = async () => {
      if (calls++ === 0) throw Object.assign(new Error("unauthorized"), { status: 401 });
      return TEST_IDENTITY;
    };
    renderWithStore(
      <AuthGate>
        <div>WORKSPACE CONTENT</div>
      </AuthGate>,
      { me },
    );

    const email = await screen.findByLabelText(/email/i);
    expect(screen.queryByText("WORKSPACE CONTENT")).not.toBeInTheDocument();

    await userEvent.type(email, "ada@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "hunter2");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /this browser is signed in/i })).toBeInTheDocument(),
    );
    expect(screen.queryByText("WORKSPACE CONTENT")).not.toBeInTheDocument();
  });

  it("shows the active account boundary on /login instead of a fake logged-in shortcut (#1512)", async () => {
    act(() => navigate("/login"));
    renderWithStore(
      <AuthGate>
        <div>WORKSPACE CONTENT</div>
      </AuthGate>,
      { me: async () => TEST_IDENTITY },
    );

    expect(await screen.findByRole("heading", { name: /this browser is signed in/i })).toBeInTheDocument();
    expect(screen.getByText(/you're signed in as ada for workspace w1/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();
    expect(screen.queryByText(/already signed in/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/you're already in/i)).not.toBeInTheDocument();
    expect(screen.queryByText("WORKSPACE CONTENT")).not.toBeInTheDocument();
  });

  it("lets a signed-in visitor sign out from /login and reach the login form (#1512)", async () => {
    act(() => navigate("/login"));
    const { store } = renderWithStore(
      <AuthGate>
        <div>WORKSPACE CONTENT</div>
      </AuthGate>,
      { me: async () => TEST_IDENTITY },
    );

    await userEvent.click(await screen.findByRole("button", { name: /sign out/i }));

    expect(store.getState().phase).toBe("anon");
    expect(window.location.pathname).toBe("/login");
    expect(await screen.findByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.queryByText("WORKSPACE CONTENT")).not.toBeInTheDocument();
  });

  it("switching from /login to sign-up reveals the workspace + display-name fields", async () => {
    act(() => navigate("/login"));
    renderWithStore(
      <AuthGate>
        <div>WORKSPACE CONTENT</div>
      </AuthGate>,
      { me: unauthorized },
    );

    await screen.findByLabelText(/email/i);
    await userEvent.click(screen.getByRole("link", { name: /create one/i }));

    expect(screen.getByLabelText(/display name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/workspace/i)).toBeInTheDocument();
    expect(window.location.pathname).toBe("/signup");
  });

  it("serves the dedicated public pricing page at /pricing (not the full landing) for a logged-out visitor", async () => {
    act(() => navigate("/pricing"));
    renderWithStore(
      <AuthGate>
        <div>WORKSPACE CONTENT</div>
      </AuthGate>,
      { me: unauthorized },
    );

    // The pricing page is code-split, so wait for it; it leads with the pricing title, not a login form.
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent(PRICING.title);
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(screen.queryByText("WORKSPACE CONTENT")).not.toBeInTheDocument();
  });

  it.each([
    [LEGAL.terms.href, LEGAL.terms.title],
    [LEGAL.privacy.href, LEGAL.privacy.title],
    [LEGAL.dpa.href, LEGAL.dpa.title],
    [COMPANY.href, COMPANY.title],
  ])("serves %s as a public legal page for logged-out visitors (#863)", async (path, title) => {
    act(() => navigate(path));
    renderWithStore(
      <AuthGate>
        <div>WORKSPACE CONTENT</div>
      </AuthGate>,
      { me: unauthorized },
    );

    expect(await screen.findByRole("heading", { level: 1, name: title })).toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(screen.queryByText("WORKSPACE CONTENT")).not.toBeInTheDocument();
  });

  it("serves the messaging-first homepage-style setup at /start for a logged-out visitor", async () => {
    act(() => navigate("/start"));
    renderWithStore(
      <AuthGate>
        <div>WORKSPACE CONTENT</div>
      </AuthGate>,
      { me: unauthorized },
    );

    expect(await screen.findByText(/marketing team in your messages/i)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /marketing work preview/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /imessage/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /whatsapp/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /telegram/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/what are we marketing today/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(screen.queryByText("WORKSPACE CONTENT")).not.toBeInTheDocument();
  });

  it("frames login as returning to messaging room setup", async () => {
    act(() => navigate("/login"));
    renderWithStore(
      <AuthGate>
        <div>WORKSPACE CONTENT</div>
      </AuthGate>,
      { me: unauthorized },
    );

    expect(await screen.findByRole("heading", { name: /sign in to your agent room/i })).toBeInTheDocument();
    expect(screen.getByText(/marketing team in your messages/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /imessage/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /whatsapp/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /telegram/i })).toBeInTheDocument();
  });

  it("frames signup as checkout for the plan chosen on /pricing (?plan=pro)", async () => {
    act(() => navigate("/signup?plan=pro&billing=year"));
    renderWithStore(
      <AuthGate>
        <div>WORKSPACE CONTENT</div>
      </AuthGate>,
      { me: unauthorized },
    );

    await screen.findByLabelText(/email/i);
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent(PRICING.trial.eyebrow);
    expect(note).toHaveTextContent(PRICING.trial.onPlan("Pro"));
  });

  it("shows the generic free-trial framing on a plain /signup (no plan chosen)", async () => {
    act(() => navigate("/signup"));
    renderWithStore(
      <AuthGate>
        <div>WORKSPACE CONTENT</div>
      </AuthGate>,
      { me: unauthorized },
    );

    await screen.findByLabelText(/email/i);
    expect(screen.getByRole("note")).toHaveTextContent(PRICING.trial.generic);
  });

  it("marks all mandatory auth inputs as browser-required with actionable constraints", async () => {
    act(() => navigate("/signup"));
    renderWithStore(
      <AuthGate>
        <div>WORKSPACE CONTENT</div>
      </AuthGate>,
      { me: unauthorized },
    );

    expect(await screen.findByLabelText(/display name/i)).toHaveAttribute("required");
    expect(screen.getByLabelText(/display name/i)).toHaveAttribute("aria-required", "true");
    expect(screen.getByLabelText(/display name/i)).toHaveAttribute("minlength", "2");
    expect(screen.getByLabelText(/email/i)).toHaveAttribute("required");
    expect(screen.getByLabelText(/email/i)).toHaveAttribute("aria-required", "true");
    expect(screen.getByLabelText(/password/i)).toHaveAttribute("required");
    expect(screen.getByLabelText(/password/i)).toHaveAttribute("aria-required", "true");
    expect(screen.getByLabelText(/password/i)).toHaveAttribute("minlength", "8");
    expect(screen.getByLabelText(/workspace/i)).toHaveAttribute("minlength", "2");
    expect(screen.getByLabelText(/workspace/i)).toHaveAttribute("pattern", "[a-z0-9][a-z0-9-]{1,62}");
    const consent = screen.getByRole("checkbox", { name: /agree to the terms/i });
    expect(consent).toHaveAttribute("required");
    expect(consent).toHaveAttribute("aria-required", "true");
    expect(screen.getByRole("link", { name: LEGAL.terms.navLabel })).toHaveAttribute("href", LEGAL.terms.href);
    expect(screen.getByRole("link", { name: LEGAL.privacy.navLabel })).toHaveAttribute("href", LEGAL.privacy.href);
    expect(screen.getByRole("link", { name: LEGAL.dpa.navLabel })).toHaveAttribute("href", LEGAL.dpa.href);
  });

  it("explains email reuse with a sign-in action", async () => {
    act(() => navigate("/signup"));
    renderWithStore(
      <AuthGate>
        <div>WORKSPACE CONTENT</div>
      </AuthGate>,
      {
        me: unauthorized,
        signup: vi.fn(async () => {
          throw new Error("email already in use");
        }),
      },
    );

    await userEvent.type(await screen.findByLabelText(/display name/i), "Ada Lovelace");
    await userEvent.type(screen.getByLabelText(/email/i), "ada@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "correct-horse");
    await userEvent.type(screen.getByLabelText(/workspace/i), "acme");
    await acceptSignupTerms();
    fireEvent.submit(screen.getByRole("button", { name: /create account/i }).closest("form")!);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That email already has an account.");
    expect(within(alert).getByRole("link", { name: /sign in instead/i })).toHaveAttribute("href", "/login");
  });

  it("explains workspace slug collisions with a suggested alternative", async () => {
    act(() => navigate("/signup"));
    renderWithStore(
      <AuthGate>
        <div>WORKSPACE CONTENT</div>
      </AuthGate>,
      {
        me: unauthorized,
        signup: vi.fn(async () => {
          throw new Error("workspace slug already exists");
        }),
      },
    );

    await userEvent.type(await screen.findByLabelText(/display name/i), "Ada Lovelace");
    await userEvent.type(screen.getByLabelText(/email/i), "ada@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "correct-horse");
    await userEvent.type(screen.getByLabelText(/workspace/i), "acme");
    await acceptSignupTerms();
    await userEvent.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That workspace URL is already taken.");
    expect(screen.getByRole("alert")).toHaveTextContent("Try acme-2.");
  });

  it("rejects short signup passwords before calling the API", async () => {
    act(() => navigate("/signup"));
    const signup = vi.fn(async () => ({ ok: true }) as const);
    renderWithStore(
      <AuthGate>
        <div>WORKSPACE CONTENT</div>
      </AuthGate>,
      { me: unauthorized, signup },
    );

    await userEvent.type(await screen.findByLabelText(/display name/i), "Ada Lovelace");
    await userEvent.type(screen.getByLabelText(/email/i), "ada@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "short");
    await userEvent.type(screen.getByLabelText(/workspace/i), "acme");
    await acceptSignupTerms();
    await userEvent.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Password must be at least 8 characters.");
    expect(signup).not.toHaveBeenCalled();
  });

  it("passes public legal consent metadata with signup submissions (#863)", async () => {
    act(() => navigate("/signup"));
    const signup = vi.fn(async () => ({ ok: true }) as const);
    renderWithStore(
      <AuthGate>
        <div>WORKSPACE CONTENT</div>
      </AuthGate>,
      { me: unauthorized, signup },
    );

    await userEvent.type(await screen.findByLabelText(/display name/i), "Ada Lovelace");
    await userEvent.type(screen.getByLabelText(/email/i), "ada@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "correct-horse");
    await userEvent.type(screen.getByLabelText(/workspace/i), "acme");
    await acceptSignupTerms();
    await userEvent.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() =>
      expect(signup).toHaveBeenCalledWith(
        expect.objectContaining({
          termsAccepted: true,
          legalConsentVersion: LEGAL.consentVersion,
          legalConsentAt: expect.any(String),
        }),
      ),
    );
  });

  it("opens hosted checkout after signup for the chosen plan, billing interval, and tracking ref (#605/#606)", async () => {
    act(() => navigate("/signup?plan=agency&billing=year&ref=ipop_deadbeefdeadbeef"));
    const checkout = vi
      .spyOn(api.billing, "startCheckout")
      .mockResolvedValue({ url: "#checkout", planKey: "agency", billingInterval: "year" });
    let calls = 0;
    const me = async () => {
      if (calls++ === 0) throw Object.assign(new Error("unauthorized"), { status: 401 });
      return TEST_IDENTITY;
    };
    renderWithStore(
      <AuthGate>
        <div>WORKSPACE CONTENT</div>
      </AuthGate>,
      { me },
    );

    await userEvent.type(await screen.findByLabelText(/display name/i), "Ada Lovelace");
    await userEvent.type(screen.getByLabelText(/email/i), "ada@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "hunter22");
    await userEvent.type(screen.getByLabelText(/workspace/i), "acme");
    await acceptSignupTerms();
    await userEvent.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByRole("heading", { name: /opening checkout/i })).toBeInTheDocument();
    expect(screen.queryByText("WORKSPACE CONTENT")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(checkout).toHaveBeenCalledWith(
        "w1",
        "agency",
        "year",
        undefined,
        "ipop_deadbeefdeadbeef",
      ),
    );
    await waitFor(() => expect(window.sessionStorage.getItem("plan-intent")).toBeNull());
    expect(window.sessionStorage.getItem("billing-interval-intent")).toBeNull();
    expect(window.sessionStorage.getItem("checkout-tracking-ref-intent")).toBeNull();
  });

  it("opens hosted checkout directly when a signed-in visitor chooses a public pricing plan (#1467)", async () => {
    act(() => navigate("/signup?plan=pro&billing=month&ref=ipop_signedin"));
    const checkout = vi
      .spyOn(api.billing, "startCheckout")
      .mockResolvedValue({ url: "#checkout", planKey: "pro", billingInterval: "month" });

    renderWithStore(
      <AuthGate>
        <div>WORKSPACE CONTENT</div>
      </AuthGate>,
      { me: async () => TEST_IDENTITY },
    );

    expect(await screen.findByRole("heading", { name: /opening checkout/i })).toBeInTheDocument();
    expect(screen.queryByText("WORKSPACE CONTENT")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(checkout).toHaveBeenCalledWith("w1", "pro", "month", undefined, "ipop_signedin"),
    );
  });

  it("does not fall through to workspace content when signed-in checkout fails (#1489)", async () => {
    act(() => navigate("/signup?plan=pro&billing=month"));
    vi.spyOn(api.billing, "startCheckout").mockRejectedValue(new Error("billing unavailable"));

    renderWithStore(
      <AuthGate>
        <div>WORKSPACE CONTENT</div>
      </AuthGate>,
      { me: async () => TEST_IDENTITY },
    );

    expect(await screen.findByRole("heading", { name: /checkout did not open/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to pricing/i })).toHaveAttribute("href", "/pricing");
    expect(screen.queryByText("WORKSPACE CONTENT")).not.toBeInTheDocument();
  });

  it("redirects a logged-out app-route hit to sign-in, preserving the return path (#304)", async () => {
    act(() => navigate("/app/reports"));
    renderWithStore(
      <AuthGate>
        <div>WORKSPACE CONTENT</div>
      </AuthGate>,
      { me: unauthorized },
    );

    // The marketing landing must NOT be served for a deep app link; the visitor lands on the messaging setup door.
    await screen.findByText(/marketing team in your messages/i);
    expect(window.location.pathname).toBe("/start");
    // …and the page they wanted is preserved so we can return them there after they sign in.
    expect(new URLSearchParams(window.location.search).get("return")).toBe("/app/reports");
    expect(screen.queryByText("WORKSPACE CONTENT")).not.toBeInTheDocument();
  });

  it("REPLACES the app-route entry on the sign-in redirect — no back-stack trap (#304)", async () => {
    act(() => navigate("/app/reports"));
    const lenAtAppRoute = window.history.length;
    const pushSpy = vi.spyOn(window.history, "pushState");
    const replaceSpy = vi.spyOn(window.history, "replaceState");

    renderWithStore(
      <AuthGate>
        <div>WORKSPACE CONTENT</div>
      </AuthGate>,
      { me: unauthorized },
    );

    await screen.findByText(/marketing team in your messages/i);
    expect(window.location.pathname).toBe("/start");
    // The redirect replaced the /app entry instead of pushing a new one, so Back can't return to the
    // dead route (which would just bounce forward again).
    expect(replaceSpy).toHaveBeenCalled();
    expect(pushSpy).not.toHaveBeenCalled();
    expect(window.history.length).toBe(lenAtAppRoute);
  });

  it("REPLACES /start?return on the post-sign-in hop, and Back from the destination does not loop (#304)", async () => {
    act(() => navigate("/start?return=%2Fapp%2Freports"));
    const lenAtStart = window.history.length;
    const pushSpy = vi.spyOn(window.history, "pushState");
    const replaceSpy = vi.spyOn(window.history, "replaceState");

    renderWithStore(
      <AuthGate>
        <div>WORKSPACE CONTENT</div>
      </AuthGate>,
      { me: async () => TEST_IDENTITY },
    );

    await waitFor(() => expect(window.location.pathname).toBe("/app/reports"));
    // The /start?return=… entry was replaced, not pushed: no extra back-stack entry, and the ?return is
    // gone so nothing can re-trigger the hop.
    expect(replaceSpy).toHaveBeenCalledWith({}, "", "/app/reports");
    expect(pushSpy).not.toHaveBeenCalled();
    expect(window.history.length).toBe(lenAtStart);
    expect(window.location.search).toBe("");

    // Simulate the visitor pressing Back to arrive at the destination: re-emitting popstate must NOT
    // push them forward again (the trap Gemini flagged).
    pushSpy.mockClear();
    replaceSpy.mockClear();
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    await waitFor(() => expect(screen.getByText("WORKSPACE CONTENT")).toBeInTheDocument());
    expect(pushSpy).not.toHaveBeenCalled();
    expect(replaceSpy).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/app/reports");
  });

  it("lands a signed-in visitor on the preserved return path after sign-in (#304)", async () => {
    act(() => navigate("/start?return=%2Fapp%2Freports"));
    renderWithStore(
      <AuthGate>
        <div>WORKSPACE CONTENT</div>
      </AuthGate>,
      { me: async () => TEST_IDENTITY },
    );

    await waitFor(() => expect(screen.getByText("WORKSPACE CONTENT")).toBeInTheDocument());
    // The ?return=<path> is honoured: the URL is restored to the originally requested page.
    await waitFor(() => expect(window.location.pathname).toBe("/app/reports"));
  });

  it("ignores an off-site return target (no open redirect) (#304)", async () => {
    act(() => navigate("/start?return=https%3A%2F%2Fevil.example.com"));
    renderWithStore(
      <AuthGate>
        <div>WORKSPACE CONTENT</div>
      </AuthGate>,
      { me: async () => TEST_IDENTITY },
    );

    await waitFor(() => expect(screen.getByText("WORKSPACE CONTENT")).toBeInTheDocument());
    // A crafted external return is refused — we stay put rather than navigating off-origin.
    expect(window.location.pathname).toBe("/start");
  });

  it("keeps a logged-in visitor out of workspace content on a bare auth route (#1489)", async () => {
    act(() => navigate("/login"));
    renderWithStore(
      <AuthGate>
        <div>WORKSPACE CONTENT</div>
      </AuthGate>,
      { me: async () => TEST_IDENTITY },
    );

    expect(await screen.findByRole("heading", { name: /this browser is signed in/i })).toBeInTheDocument();
    expect(screen.queryByText("WORKSPACE CONTENT")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
  });
});
