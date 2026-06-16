import { afterEach, describe, expect, it } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthGate } from "./AuthGate.js";
import { navigate } from "../routing.js";
import { PRICING } from "../brand.js";
import { TEST_IDENTITY, renderWithStore } from "../test/utils.js";

const unauthorized = () => {
  throw Object.assign(new Error("unauthorized"), { status: 401 });
};

afterEach(() => {
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
    await userEvent.type(screen.getByLabelText(/password/i), "hunter2");
    await userEvent.type(screen.getByLabelText(/workspace/i), "acme");
    await userEvent.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => expect(screen.getByText("WORKSPACE CONTENT")).toBeInTheDocument());
    expect(window.sessionStorage.getItem("plan-intent")).toBe("agency");
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
