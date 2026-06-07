import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MessagePane } from "./MessagePane.js";
import { makeMessage, renderWithStore } from "../test/utils.js";

describe("MessagePane", () => {
  it("renders messages with resolved author names", async () => {
    const { store } = renderWithStore(<MessagePane />);
    await store.bootstrap();
    expect(await screen.findByText("first post")).toBeInTheDocument();
    expect(screen.getByText("Ada")).toBeInTheDocument();
  });

  it("marks agent authors with an AGENT badge (agent-first)", async () => {
    const { store } = renderWithStore(<MessagePane />, {
      messages: [makeMessage({ id: "m1", authorMemberId: "ag1", body: "deployed v2" })],
    });
    await store.bootstrap();

    expect(await screen.findByText("Atlas")).toBeInTheDocument();
    expect(screen.getByText("AGENT")).toBeInTheDocument();
  });

  it("appends a realtime message without a refresh", async () => {
    const { store, rt } = renderWithStore(<MessagePane />);
    await store.bootstrap();
    await screen.findByText("first post");

    rt.fire({ type: "message", message: makeMessage({ id: "m2", channelId: "c1", body: "live update" }) });

    await waitFor(() => expect(screen.getByText("live update")).toBeInTheDocument());
  });

  it("keeps thread replies out of the channel unless they were also sent to it", async () => {
    const { store } = renderWithStore(<MessagePane />, {
      messages: [
        makeMessage({ id: "root", body: "deploy thread" }),
        makeMessage({ id: "r1", parentMessageId: "root", body: "hidden reply" }),
        makeMessage({ id: "r2", parentMessageId: "root", alsoSentToChannel: true, body: "shared reply" }),
      ],
    });
    await store.bootstrap();

    expect(await screen.findByText("deploy thread")).toBeInTheDocument();
    expect(screen.getByText("shared reply")).toBeInTheDocument();
    expect(screen.queryByText("hidden reply")).not.toBeInTheDocument();
  });

  it("opens a thread when a message's reply control is clicked", async () => {
    const { store } = renderWithStore(<MessagePane />);
    await store.bootstrap();
    await screen.findByText("first post");

    await userEvent.click(screen.getByRole("button", { name: /reply in thread/i }));
    await waitFor(() => expect(store.getState().thread?.root.id).toBe("m1"));
  });
});
