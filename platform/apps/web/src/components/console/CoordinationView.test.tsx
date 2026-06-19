/**
 * CoordinationView tests (#352/#384). Prove the surface re-mounts the orphaned reload.chat components wired to
 * the EXISTING store (channels / messages / directory) — and that agent-authored content is rendered as DATA
 * (plain text), never markup (#200 injection-defense).
 *
 * #384: the surface is header + feed + composer + members ONLY. The "Team coordination" preamble and the
 * Mission-control running-sessions TABLE were removed; the region stays nameable via its `aria-label`.
 */
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { CONSOLE } from "../../brand.js";
import { CoordinationView } from "./CoordinationView.js";
import { makeMessage, renderWithStore } from "../../test/utils.js";

describe("CoordinationView (#352/#384)", () => {
  it("re-mounts the coordination components wired to the existing store (feed + members)", async () => {
    const { store } = renderWithStore(<CoordinationView />);
    await store.bootstrap();

    // The region is still nameable (the title survives as the accessible label, not visible chrome).
    expect(screen.getByLabelText(CONSOLE.coordination.title)).toBeInTheDocument();
    // MessagePane wired to messagesByChannel (the seeded channel's first message).
    expect(await screen.findByText("first post")).toBeInTheDocument();
    // MembersRail wired to the directory.
    expect(screen.getByText("Members")).toBeInTheDocument();
  });

  // #384: the ipop-only chrome that pushed the feed down is gone — no "Team coordination" preamble and no
  // mission-control sessions TABLE above the feed. Running status arrives as in-channel messages instead.
  it("renders NO preamble and NO mission-control table above the feed (#384)", async () => {
    const { container, store } = renderWithStore(<CoordinationView />);
    await store.bootstrap();

    await screen.findByText("first post");
    // The visible preamble title and its one-line sub are gone (the string survives only as the aria-label).
    expect(screen.queryByRole("heading", { name: CONSOLE.coordination.title })).toBeNull();
    expect(screen.queryByText(CONSOLE.coordination.sub)).toBeNull();
    // The mission-control table is gone entirely.
    expect(container.querySelector(".coord__live")).toBeNull();
    expect(container.querySelector(".mission")).toBeNull();
    expect(container.querySelector(".mission__table")).toBeNull();
    expect(screen.queryByText("Mission control")).toBeNull();
    // What remains is the single body: feed + composer + members.
    expect(container.querySelector(".coord__body")).not.toBeNull();
    expect(container.querySelector(".coord__head")).toBeNull();
    expect(container.querySelector(".messagelist")).not.toBeNull();
    expect(container.querySelector(".composer")).not.toBeNull();
    expect(container.querySelector(".members")).not.toBeNull();
  });

  it("renders agent/channel content as DATA (plain text), never as markup", async () => {
    const payload = "<img src=x onerror=alert(1)>";
    const { store, container } = renderWithStore(<CoordinationView />, {
      messages: [makeMessage({ id: "m1", body: payload })],
    });
    await store.bootstrap();

    // The injection payload appears verbatim as text — and no <img> element is ever created from the body.
    expect(await screen.findByText(payload)).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });
});
