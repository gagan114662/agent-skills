import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import MarketingSite from "./MarketingSite.js";
import { api } from "../../api/client.js";
import { SITE, ASK_AI, BRAND_ASSETS, SEGMENT_LANDING_PAGES, STORY_RECEIPTS } from "../../brand.js";
import type { SiteBlock } from "../../api/types.js";

/** Point the (history-API) router at a path before rendering the lazy-free site component. */
function at(path: string): void {
  window.history.pushState({}, "", path);
}

const meta = (slug: string, title: string) => ({
  section: "compare",
  slug,
  title,
  description: `About ${title}`,
  kind: "compare",
  agent: "quill",
  date: "2026-06-11",
  status: "published" as const,
  meta: {},
});

const blocks: SiteBlock[] = [
  { type: "heading", level: 1, inline: [{ type: "text", text: "Heads up" }] },
  { type: "paragraph", inline: [{ type: "text", text: "A point." }] },
  {
    type: "table",
    header: [[{ type: "text", text: "A" }], [{ type: "text", text: "B" }]],
    rows: [[[{ type: "text", text: "1" }], [{ type: "text", text: "2" }]]],
  },
];

afterEach(() => {
  vi.restoreAllMocks();
  at("/");
});

describe("#153 marketing site", () => {
  it("every page is footed with the dogfood credit and the Ask-AI deep links", async () => {
    vi.spyOn(api.site, "section").mockResolvedValue([]);
    at("/compare");
    render(<MarketingSite />);

    // The "maintained by Quill" credit (the twist) on every page.
    expect(await screen.findByText(SITE.maintainedBy)).toBeInTheDocument();

    // The three Ask-AI assistants, each a deep link with the prompt encoded.
    const encoded = encodeURIComponent(ASK_AI.prompt);
    for (const provider of ASK_AI.providers) {
      const link = screen.getByRole("link", { name: new RegExp(provider.label, "i") });
      expect(link).toHaveAttribute("href", `${provider.base}${encoded}`);
    }
  });

  it("renders a section index as cards that link to each document", async () => {
    vi.spyOn(api.site, "section").mockResolvedValue([meta("vs-diy", "ipop vs. DIY")]);
    at("/compare");
    render(<MarketingSite />);

    const card = await screen.findByText("ipop vs. DIY");
    expect(card.closest("a")).toHaveAttribute("href", "/compare/vs-diy");
  });

  it("renders a document's blocks (heading, paragraph, table) with a back link", async () => {
    const spy = vi.spyOn(api.site, "doc").mockResolvedValue({ ...meta("vs-diy", "ipop vs. DIY"), blocks });
    at("/compare/vs-diy");
    render(<MarketingSite />);

    expect(await screen.findByText("A point.")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: new RegExp(SITE.backToSite.replace("←", "").trim(), "i") })).toHaveAttribute(
      "href",
      "/compare",
    );
    expect(spy).toHaveBeenCalledWith("compare", "vs-diy");
  });

  it("shows a friendly empty state when a section has no published content", async () => {
    vi.spyOn(api.site, "section").mockResolvedValue([]);
    at("/guides");
    render(<MarketingSite />);
    expect(await screen.findByText(SITE.empty)).toBeInTheDocument();
  });

  it("renders /stories from receipt-backed proof data instead of an ellipsis placeholder (#1178)", async () => {
    vi.spyOn(api.site, "section").mockResolvedValue([]);
    at("/stories");
    render(<MarketingSite />);

    expect(await screen.findByRole("region", { name: /receipt-backed stories/i })).toBeInTheDocument();
    for (const story of STORY_RECEIPTS) {
      expect(screen.getByRole("article", { name: story.customer })).toBeInTheDocument();
      expect(screen.getByText(story.consentStatus)).toBeInTheDocument();
    }
    expect(screen.getByText("No external receipt published yet.")).toBeInTheDocument();
    expect(screen.queryByText("…")).not.toBeInTheDocument();
  });

  it("renders the brand kit with the Pop Vermilion palette swatch", () => {
    at("/brand");
    render(<MarketingSite />);
    expect(screen.getByText(BRAND_ASSETS.title)).toBeInTheDocument();
    // Pop Vermilion shows in the palette and again as Scout's department hue — at least one swatch.
    expect(screen.getAllByText("#ff4524").length).toBeGreaterThan(0);
  });

  it("renders a segment-specific landing page without calling the content API", () => {
    const spy = vi.spyOn(api.site, "section").mockResolvedValue([]);
    const segment = SEGMENT_LANDING_PAGES[0]!;
    at(segment.path);
    render(<MarketingSite />);

    expect(screen.getByRole("heading", { level: 1, name: segment.hero.title })).toBeInTheDocument();
    expect(screen.getByText(segment.proof.title)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: segment.cta.label })).toHaveAttribute("href", segment.cta.href);
    expect(spy).not.toHaveBeenCalled();
  });

  it("links every nav section in the shared shell", async () => {
    vi.spyOn(api.site, "section").mockResolvedValue([]);
    at("/changelog");
    render(<MarketingSite />);
    const nav = screen.getByRole("navigation", { name: /marketing site/i });
    for (const item of SITE.nav) {
      expect(within(nav).getByRole("link", { name: item.label })).toHaveAttribute("href", item.href);
    }
  });
});
