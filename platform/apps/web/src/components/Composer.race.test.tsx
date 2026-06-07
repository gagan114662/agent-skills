import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Composer } from "./Composer.js";
import { renderWithStore } from "../test/utils.js";
import type { MemberHit } from "../api/types.js";

/** A deferred promise we can resolve on demand to control search-response ordering. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("Composer mention autocomplete — stale response race", () => {
  it("ignores an earlier search that resolves after a later one", async () => {
    const { store } = renderWithStore(<Composer />);
    await store.bootstrap();

    const calls: Array<ReturnType<typeof deferred<MemberHit[]>>> = [];
    vi.spyOn(store, "searchMembers").mockImplementation(() => {
      const d = deferred<MemberHit[]>();
      calls.push(d);
      return d.promise;
    });

    const textarea = screen.getByRole("textbox");
    await userEvent.type(textarea, "@A"); // fires searches for "" then "A"
    await userEvent.type(textarea, "t"); // now "@At" → fires search for "At"

    const atQuery = calls[calls.length - 1]!; // newest query ("At")
    const aQuery = calls[calls.length - 2]!; // older, broader query ("A")

    // Newest query resolves FIRST with the narrow result…
    atQuery.resolve([{ id: "ag1", kind: "agent", displayName: "Atlas" }]);
    // …then the stale earlier query resolves with a broader set that must be discarded.
    aQuery.resolve([
      { id: "me1", kind: "human", displayName: "Ada" },
      { id: "ag1", kind: "agent", displayName: "Atlas" },
    ]);
    calls.slice(0, calls.length - 2).forEach((d) => d.resolve([])); // drain the rest

    await waitFor(() => expect(screen.getByRole("option", { name: /Atlas/ })).toBeInTheDocument());
    expect(screen.queryByRole("option", { name: /Ada/ })).not.toBeInTheDocument();
  });
});
