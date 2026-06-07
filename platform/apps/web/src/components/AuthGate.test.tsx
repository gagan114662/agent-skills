import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthGate } from "./AuthGate.js";
import { TEST_IDENTITY, renderWithStore } from "../test/utils.js";

describe("AuthGate", () => {
  it("shows the sign-in form when unauthenticated, then renders children after login", async () => {
    let calls = 0;
    const me = async () => {
      // First bootstrap (on mount) is anonymous; after login the session resolves.
      if (calls++ === 0) throw Object.assign(new Error("unauthorized"), { status: 401 });
      return TEST_IDENTITY;
    };
    renderWithStore(<AuthGate>
      <div>WORKSPACE CONTENT</div>
    </AuthGate>, { me });

    const email = await screen.findByLabelText(/email/i);
    expect(screen.queryByText("WORKSPACE CONTENT")).not.toBeInTheDocument();

    await userEvent.type(email, "ada@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "hunter2");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(screen.getByText("WORKSPACE CONTENT")).toBeInTheDocument());
  });

  it("can switch to the sign-up form (workspace + display name fields appear)", async () => {
    renderWithStore(<AuthGate>
      <div>WORKSPACE CONTENT</div>
    </AuthGate>, {
      me: async () => {
        throw Object.assign(new Error("unauthorized"), { status: 401 });
      },
    });

    await screen.findByLabelText(/email/i);
    await userEvent.click(screen.getByRole("button", { name: /create one/i }));

    expect(screen.getByLabelText(/display name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/workspace/i)).toBeInTheDocument();
  });
});
