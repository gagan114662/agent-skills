/**
 * Layout regression guard for #381 — the coordination surface shipped UNUSABLE: the message feed would not
 * scroll and the composer was pushed off-screen, so the owner could not message a teammate or brief a lead.
 *
 * Root cause (see ADR-0381): the `.coord__body` grid had no row track, so its single implicit row sized to
 * CONTENT (all ~93 messages, ~10000px). `.pane` (a grid item) therefore grew to fit every message, so its
 * `.messagelist` — `flex: 1; overflow-y: auto` — never had a constrained parent and never became a scroll
 * region (scrollHeight === clientHeight). The whole pane overflowed the viewport, carrying the bottom-pinned
 * `Composer` below the fold.
 *
 * The invariants this test pins (jsdom can't compute CSS layout, so the layout rules are asserted against the
 * stylesheet source directly — same approach as PricingTable.visibility.test.ts / brand.test.ts):
 *   1. `.coord__body` constrains its row track (`grid-template-rows: minmax(0, 1fr)`) so the grid fills the
 *      pane height instead of growing to message content.
 *   2. `.pane` carries `min-height: 0` so it can shrink below its content, handing the overflow to…
 *   3. `.messagelist`, the single `flex: 1; overflow-y: auto` scroll region.
 * Plus a structural DOM guard: with 93 messages rendered the `Composer` stays a SIBLING that follows the
 * scroll region inside `.pane` (pinned to the bottom, never inside the scroll area), and remains reachable.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { screen } from "@testing-library/react";
import { CoordinationView } from "./CoordinationView.js";
import { makeMessage, renderWithStore } from "../../test/utils.js";

// MissionControlPanel reads the #147 seam straight off the real api client; stub it to an empty snapshot so
// the layout test has no network / no 4s polling (mirrors CoordinationView.test.tsx).
vi.mock("../../api/client.js", async (orig) => {
  const actual = await orig<typeof import("../../api/client.js")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      missionControl: {
        ...actual.api.missionControl,
        get: vi.fn(async () => ({
          sessions: [],
          count: 0,
          totalEstimatedCostCents: 0,
          rateCentsPerMinute: 0,
          costIsEstimate: true as const,
        })),
      },
    },
  };
});

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "../../styles.css"), "utf8");

/** Extract the body of an exact top-level `<selector> {` rule (first match, never a `--mod`/`__el` variant). */
function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `the ${selector} rule must exist`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

describe("coordination layout (#381 — feed scrolls, composer stays pinned & reachable)", () => {
  it(".coord__body constrains its grid rows so the pane fills height (not message content)", () => {
    const body = ruleBody(".coord__body");
    // The bug: no row track ⇒ the single implicit row sized to content (~10000px), overflowing the viewport.
    expect(body, ".coord__body must declare a row track").toMatch(/grid-template-rows\s*:/);
    // `minmax(0, 1fr)` caps the row at the available height (min 0) so grid children can shrink-to-scroll.
    expect(body, "the row track must be minmax(0, 1fr) so the row can shrink below content").toMatch(
      /grid-template-rows\s*:\s*minmax\(\s*0\s*,\s*1fr\s*\)/,
    );
  });

  it(".pane can shrink below its content (min-height: 0) so the scroll region engages", () => {
    const body = ruleBody(".pane");
    expect(body, ".pane must set min-height: 0 (a grid item defaults to min-height: auto)").toMatch(
      /min-height\s*:\s*0/,
    );
  });

  it(".messagelist is the single flex:1 overflow-y:auto scroll region", () => {
    const body = ruleBody(".messagelist");
    expect(body, ".messagelist must be flex:1 so it takes the remaining pane height").toMatch(/flex\s*:\s*1/);
    expect(body, ".messagelist must own the overflow (the one scroll region)").toMatch(
      /overflow-y\s*:\s*auto/,
    );
  });

  it("long agent output wraps inside message and log panels instead of widening the page (#652)", () => {
    const message = ruleBody(".message");
    expect(message, "message rows must be allowed to shrink inside the feed").toMatch(/min-width\s*:\s*0/);
    expect(message, "message rows must never exceed the feed width").toMatch(/max-width\s*:\s*100%/);

    const text = ruleBody(".message__text");
    expect(text).toMatch(/white-space\s*:\s*pre-wrap/);
    expect(text).toMatch(/overflow-wrap\s*:\s*anywhere/);
    expect(text).toMatch(/word-break\s*:\s*break-word/);

    for (const selector of [".run__logs", ".deploy__logs", ".diff__patch"]) {
      const body = ruleBody(selector);
      expect(body, `${selector} must stay inside its panel`).toMatch(/max-width\s*:\s*100%/);
      expect(body, `${selector} must own overflow instead of pushing the page`).toMatch(/overflow\s*:\s*auto/);
    }

    const diffLine = ruleBody(".diff__line");
    expect(diffLine).toMatch(/white-space\s*:\s*pre-wrap/);
    expect(diffLine).toMatch(/overflow-wrap\s*:\s*anywhere/);
  });

  it("with 93 messages the composer stays a sibling AFTER the scroll region and is reachable", async () => {
    // 93 messages — the live count the #381 diagnosis captured. All top-level so the channel view shows them.
    const messages = Array.from({ length: 93 }, (_, i) =>
      makeMessage({ id: `m${i}`, channelId: "c1", body: `message number ${i}` }),
    );
    const { store, container } = renderWithStore(<CoordinationView />, { messages });
    await store.bootstrap();

    // The feed actually holds all 93 rows…
    expect(await screen.findByText("message number 0")).toBeInTheDocument();
    expect(screen.getByText("message number 92")).toBeInTheDocument();

    // …inside exactly ONE scroll region.
    const lists = container.querySelectorAll(".messagelist");
    expect(lists, "there must be exactly one scroll region").toHaveLength(1);
    const messagelist = lists[0]!;

    // The composer is reachable (queryable, not aria-hidden) — the owner can type a message.
    const composerInput = screen.getByRole("textbox");
    expect(composerInput).toBeInTheDocument();

    // …and it is PINNED below the feed: a sibling of the scroll region (NOT inside it), following it in DOM
    // order. This is what keeps it on-screen no matter how tall the feed grows.
    const pane = messagelist.parentElement!;
    const composer = pane.querySelector(".composer");
    expect(composer, "the composer must live in the pane").not.toBeNull();
    expect(messagelist.contains(composer), "the composer must NOT be inside the scroll region").toBe(false);
    expect(
      messagelist.compareDocumentPosition(composer!) & Node.DOCUMENT_POSITION_FOLLOWING,
      "the composer must come AFTER the scroll region (pinned to the bottom of the pane)",
    ).toBeTruthy();
  });
});
