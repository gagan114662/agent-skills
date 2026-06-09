import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Composer } from "./Composer.js";
import { createStore, type Store } from "../store/store.js";
import { StoreProvider } from "../store/StoreContext.js";
import { makeFakeDeps } from "../test/utils.js";
import type { Message } from "../api/types.js";

/** Render the channel composer with the agent "parked": postMessage never resolves, so the first
 * queued message stays in flight and everything stacked behind it remains visibly queued. */
function renderQueue(): { store: Store; user: ReturnType<typeof userEvent.setup> } {
  const { deps } = makeFakeDeps();
  deps.api.postMessage = vi.fn((): Promise<Message> => new Promise<Message>(() => {}));
  const store = createStore(deps);
  render(
    <StoreProvider store={store}>
      <Composer queue />
    </StoreProvider>,
  );
  return { store, user: userEvent.setup() };
}

const composer = () => screen.getByPlaceholderText(/message/i);
const queueList = () => screen.getByRole("list", { name: /queued messages/i });

async function stack(user: ReturnType<typeof userEvent.setup>, text: string, btn = /^queue$/i) {
  await user.clear(composer());
  await user.type(composer(), text);
  await user.click(screen.getByRole("button", { name: btn }));
}

describe("MessageQueue UI", () => {
  it("stacks a message with the Queue button and shows it in the queue list", async () => {
    const { store, user } = renderQueue();
    await store.bootstrap();

    await stack(user, "warmup"); // occupies the in-flight slot
    await stack(user, "ship the release");

    await waitFor(() => expect(queueList()).toBeInTheDocument());
    expect(within(queueList()).getByText("ship the release")).toBeInTheDocument();
  });

  it("editing a queued row opens an inline editor that preserves the partial text", async () => {
    const { store, user } = renderQueue();
    await store.bootstrap();
    await stack(user, "warmup");
    await stack(user, "deploy now");

    await user.click(await screen.findByRole("button", { name: /edit message/i }));
    const editor = screen.getByRole("textbox", { name: /edit queued message/i });
    expect(editor).toHaveValue("deploy now");

    await user.clear(editor);
    await user.type(editor, "deploy later");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(within(queueList()).getByText("deploy later")).toBeInTheDocument());
  });

  it("the Steer button stacks a message marked as a steer", async () => {
    const { store, user } = renderQueue();
    await store.bootstrap();
    await stack(user, "warmup");
    await stack(user, "actually, focus on tests", /^steer$/i);

    const row = within(queueList()).getByText("actually, focus on tests").closest("li");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText(/steer/i)).toBeInTheDocument();
  });

  it("removes a row via its control and reorders with the move buttons", async () => {
    const { store, user } = renderQueue();
    await store.bootstrap();
    await stack(user, "warmup");
    await stack(user, "one");
    await stack(user, "two");

    // reorder: move "two" up so it precedes "one"
    const twoRow = within(queueList()).getByText("two").closest("li") as HTMLElement;
    await user.click(within(twoRow).getByRole("button", { name: /move up/i }));
    let rows = within(queueList()).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("two"),
      expect.stringContaining("one"),
    ]);

    // remove "one"
    const oneRow = within(queueList()).getByText("one").closest("li") as HTMLElement;
    await user.click(within(oneRow).getByRole("button", { name: /remove from queue/i }));
    await waitFor(() => {
      rows = within(queueList()).getAllByRole("listitem");
      expect(rows).toHaveLength(1);
    });
  });

  it("supports keyboard navigation: select with arrows, delete the highlighted row", async () => {
    const { store, user } = renderQueue();
    await store.bootstrap();
    await stack(user, "warmup");
    await stack(user, "alpha");
    await stack(user, "beta");

    const list = queueList();
    fireEvent.keyDown(list, { key: "ArrowDown" }); // select first row (alpha)
    fireEvent.keyDown(list, { key: "Delete" }); // remove it

    await waitFor(() => {
      const rows = within(queueList()).getAllByRole("listitem");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.textContent).toContain("beta");
    });
  });
});
