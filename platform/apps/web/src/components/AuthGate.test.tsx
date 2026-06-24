import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthGate } from "./AuthGate.js";
import { navigate } from "../routing.js";
import { PRICING } from "../brand.js";
import { TEST_IDENTITY, renderWithStore } from "../test/utils.js";

const unauthorized = () => {
  throw Object.assign(new Error("unauthorized"), { status: 401 });
};

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

    await waitFor(() => expect(screen.getByText("WORKSPACE CONTENT")).toBeInTheDocument());
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

  it("serves the #260 onboarding screen at /start for a logged-out visitor (domain + Google, no password)", async () => {
    act(() => navigate("/start"));
    renderWithStore(
      <AuthGate>
        <div>WORKSPACE CONTENT</div>
      </AuthGate>,
      { me: unauthorized },
    );

    expect(await screen.findByRole("button", { name: /sign in with google/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/your website/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(screen.queryByText("WORKSPACE CONTENT")).not.toBeInTheDocument();
  });

  it("frames signup as a free trial of the plan chosen on /pricing (?plan=pro)", async () => {
    act(() => navigate("/signup?plan=pro"));
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
    expect(screen.getByLabelText(/workspace/i)).toHaveAttribute("required");
    expect(screen.getByLabelText(/workspace/i)).toHaveAttribute("aria-required", "true");
    expect(screen.getByLabelText(/workspace/i)).toHaveAttribute("minlength", "2");
    expect(screen.getByLabelText(/workspace/i)).toHaveAttribute("pattern", "[a-z0-9][a-z0-9-]{1,62}");
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
    await userEvent.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Password must be at least 8 characters.");
    expect(signup).not.toHaveBeenCalled();
  });

  it("hands the chosen plan off to the activation/first-run via sessionStorage on signup", async () => {
    act(() => navigate("/signup?plan=agency"));
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
    await userEvent.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => expect(screen.getByText("WORKSPACE CONTENT")).toBeInTheDocument());
    expect(window.sessionStorage.getItem("plan-intent")).toBe("agency");
  });

  it("redirects a logged-out app-route hit to sign-in, preserving the return path (#304)", async () => {
    act(() => navigate("/app/reports"));
    renderWithStore(
      <AuthGate>
        <div>WORKSPACE CONTENT</div>
      </AuthGate>,
      { me: unauthorized },
    );

    // The marketing landing must NOT be served for a deep app link; the visitor lands on sign-in (/start).
    await screen.findByRole("button", { name: /sign in with google/i });
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

    await screen.findByRole("button", { name: /sign in with google/i });
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

  it("sends a logged-in visitor straight to the app, even on an auth route", async () => {
    act(() => navigate("/login"));
    renderWithStore(
      <AuthGate>
        <div>WORKSPACE CONTENT</div>
      </AuthGate>,
      { me: async () => TEST_IDENTITY },
    );

    await waitFor(() => expect(screen.getByText("WORKSPACE CONTENT")).toBeInTheDocument());
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
  });
});
