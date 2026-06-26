import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { OnboardingExperience } from "./OnboardingExperience.js";
import { listPostMeta } from "../../blog/posts.js";
import { SUPPORT_CONTACT } from "../../brand.js";
import { ipopExperienceTokens } from "../../design/ipop-experience-tokens.js";
import type {
  ConnectResult,
  ConnectTool,
  DeliverableDraft,
  OnboardingProvider,
  SiteFinding,
  TeamMission,
} from "./provider.js";
import { OnboardingReadError } from "./provider.js";

/**
 * #784 onboarding experience — the demo-to-product leap. The provider is injected so the whole flow (door →
 * real finding → guided connects each with an IMMEDIATE real payoff → one approved deliverable that ships)
 * runs synchronously under jsdom, including the honest read-degrade and the hard money gate.
 */

const FINDING: SiteFinding = {
  host: "acme.com",
  name: "Acme",
  finding: "your hero buries the offer below the fold.",
};

const TEAM_MISSION: TeamMission = {
  id: "mission-acme",
  target: "acme.com",
  objective: "turn Acme into a live customer-acquisition motion",
  agents: [
    { who: "scout", role: "customer truth", status: "handoff", current: "read acme.com and found the offer gap" },
    { who: "quill", role: "copy + content", status: "working", current: "drafting the sharper hero" },
    { who: "echo", role: "distribution", status: "blocked", current: "waiting on Reddit/X access" },
    { who: "bid", role: "paid growth", status: "gated", current: "holding spend for approval" },
  ],
  handoffs: [
    "scout -> quill: positioning gap",
    "quill -> echo: launch angle",
    "echo -> bid: paid only after organic proof",
  ],
  artifacts: [
    { title: "site-read receipt", summary: "your hero buries the offer below the fold." },
    { title: "first deliverable queued", summary: "hero rewrite + launch-week post plan" },
  ],
  receipts: ["site read: acme.com", "team mission recorded", "send/spend gates active"],
  blockedPermissions: ["Gmail", "Reddit/X", "site publishing"],
};

function payoff(tool: ConnectTool): ConnectResult {
  if (tool === "gmail") {
    return {
      tool,
      lead: { from: "priya@brightfox.io", subject: "re: team plans?" },
      draft: "hi priya — yes we do.",
    };
  }
  if (tool === "social") {
    return {
      tool,
      threads: [
        {
          source: "r/marketing",
          title: "best tool for a tiny team?",
          draft: "be helpful, not salesy.",
        },
        { source: "x · #buildinpublic", title: "launch help?", draft: "one concrete tip." },
        { source: "r/SaaS", title: "onboarding emails?", draft: "answer first." },
      ],
    };
  }
  return { tool, before: "Welcome to Acme.", after: "Acme: the work gets done while you sleep." };
}

function fakeProvider(over: Partial<OnboardingProvider> = {}): OnboardingProvider {
  return {
    readSite: () => Promise.resolve(FINDING),
    startTeam: () => Promise.resolve(TEAM_MISSION),
    connect: (tool) => Promise.resolve(payoff(tool)),
    buildDeliverable: (): Promise<DeliverableDraft> =>
      Promise.resolve({
        title: "Acme's new hero + a launch week",
        body: "all from your real accounts.",
        spendsMoney: false,
      }),
    ship: () => Promise.resolve({ shipped: true as const }),
    ...over,
  };
}

function expectPublicLinks(): void {
  expect(screen.getAllByRole("link", { name: "Pricing" })[0]).toHaveAttribute("href", "/pricing");
  expect(screen.getAllByRole("link", { name: "Company" })[0]).toHaveAttribute("href", "/company");
  expect(screen.getAllByRole("link", { name: "Security & trust" })[0]).toHaveAttribute(
    "href",
    "/security",
  );
  expect(screen.getAllByRole("link", { name: "Terms" })[0]).toHaveAttribute("href", "/terms");
  expect(screen.getAllByRole("link", { name: "Privacy" })[0]).toHaveAttribute("href", "/privacy");
  expect(screen.getAllByRole("link", { name: "Contact" })[0]).toHaveAttribute(
    "href",
    SUPPORT_CONTACT.href,
  );
}

describe("OnboardingExperience (#784)", () => {
  it("renders from the shared ipop experience token contract (#1068)", () => {
    const { container } = render(<OnboardingExperience provider={fakeProvider()} hour={14} />);
    const root = container.querySelector<HTMLElement>(".onboard");

    expect(root).not.toBeNull();
    expect(root).toHaveStyle({
      "--o-canvas": ipopExperienceTokens.color.canvas,
      "--o-surface": ipopExperienceTokens.color.surface,
      "--o-pop": ipopExperienceTokens.color.accent,
      "--o-serif": ipopExperienceTokens.typography.serif,
      "--o-sans": ipopExperienceTokens.typography.sans,
    });
  });

  it("opens on the warm door — one simple promise, one input, nothing else", () => {
    render(<OnboardingExperience provider={fakeProvider()} hour={14} name="gagan" />);
    expect(screen.getByText(/make marketing pop/i)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /marketing work preview/i })).toBeInTheDocument();
    expect(screen.getByText(/customer/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /login/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /love/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /start/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/what are we marketing today/i)).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: /ipop cowork room/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/your marketing team, already at the table/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/send\/spend policy locked/i)).not.toBeInTheDocument();
    // No agent thread / connect prompts on the door.
    expect(screen.queryByText(/lend us your gmail/i)).not.toBeInTheDocument();
  });

  it("keeps finished-work proof behind the dashboard so the homepage stays clean (#571)", () => {
    const [latestPost] = listPostMeta();
    if (!latestPost) throw new Error("expected at least one published blog post for onboarding proof");
    render(<OnboardingExperience provider={fakeProvider()} hour={14} />);

    expect(screen.queryByRole("region", { name: /finished work proof/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/already shipped/i)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /dashboard/i })).toHaveAttribute("href", "/everyday");
    expect(latestPost).toBeDefined();
  });

  it("nudges (does not advance) on an empty submit", () => {
    render(<OnboardingExperience provider={fakeProvider()} hour={9} />);
    fireEvent.click(screen.getByRole("button", { name: /start/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/give us a product or a url/i);
  });

  it("starts a coordinated team mission with one action and shows agents, handoffs, artifacts, and blockers", async () => {
    const startTeam = vi.fn(() => Promise.resolve(TEAM_MISSION));
    render(<OnboardingExperience provider={fakeProvider({ startTeam })} hour={14} />);

    fireEvent.change(screen.getByLabelText(/what are we marketing today/i), {
      target: { value: "acme.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /start/i }));

    expect(await screen.findByText(/send\/spend gates active/i)).toBeInTheDocument();
    expect(startTeam).toHaveBeenCalledWith("acme.com", FINDING);
    expect(screen.getByText(/turn Acme into a live customer-acquisition motion/i)).toBeInTheDocument();
    expect(screen.getByText(/read acme\.com and found the offer gap/i)).toBeInTheDocument();
    expect(screen.getByText(/drafting the sharper hero/i)).toBeInTheDocument();
    expect(screen.getByText(/waiting on Reddit\/X access/i)).toBeInTheDocument();
    expect(screen.getByText(/holding spend for approval/i)).toBeInTheDocument();
    expect(screen.getByText(/scout -> quill: positioning gap/i)).toBeInTheDocument();
    expect(screen.getByText(/site-read receipt/i)).toBeInTheDocument();
    expect(screen.getByText(/blocked until real access: Gmail, Reddit\/X, site publishing/i)).toBeInTheDocument();
  });

  it("streams a personalized first deliverable before asking for setup or connectors (#570)", async () => {
    render(<OnboardingExperience provider={fakeProvider()} hour={14} />);

    fireEvent.change(screen.getByLabelText(/what are we marketing today/i), {
      target: { value: "acme.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /start/i }));

    const instant = await screen.findByRole("article", { name: /instant personalized deliverable/i });
    expect(within(instant).getByText(/streaming now/i)).toBeInTheDocument();
    expect(within(instant).getByText(/Acme's first useful thing/i)).toBeInTheDocument();
    expect(within(instant).getByRole("list", { name: /agent work stream/i })).toHaveTextContent(
      /scout read acme\.comquill drafted from the findingready for your approval/i,
    );
    expect(within(instant).getByText(/your hero buries the offer below the fold/i)).toBeInTheDocument();
    expect(
      within(instant).getByRole("button", { name: /approve this first result/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/lend us your gmail/i)).not.toBeInTheDocument();
  });

  it("lets a new user approve the first result without opening settings or connectors (#525)", async () => {
    const ship = vi.fn(() => Promise.resolve({ shipped: true as const }));
    render(<OnboardingExperience provider={fakeProvider({ ship })} hour={14} />);

    fireEvent.change(screen.getByLabelText(/what are we marketing today/i), {
      target: { value: "acme.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /start/i }));

    const instant = await screen.findByRole("article", { name: /instant personalized deliverable/i });
    fireEvent.click(within(instant).getByRole("button", { name: /approve this first result/i }));

    expect(await screen.findByText(/that's a real thing you just did/i)).toBeInTheDocument();
    expect(ship).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/lend us your gmail/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/open real connections/i)).not.toBeInTheDocument();
  });

  it("starts the real Google auth handoff from the public Gmail allow step", async () => {
    const connect = vi.fn((tool: ConnectTool) => Promise.resolve(payoff(tool)));
    const startGoogleAuth = vi.fn();
    render(
      <OnboardingExperience
        provider={fakeProvider({ connect })}
        hour={14}
        startGoogleAuth={startGoogleAuth}
      />,
    );

    fireEvent.change(screen.getByLabelText(/what are we marketing today/i), {
      target: { value: "acme.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /start/i }));
    fireEvent.click(await screen.findByRole("button", { name: /plug in your actual stuff/i }));
    fireEvent.click(screen.getByRole("button", { name: /^allow$/i }));

    expect(startGoogleAuth).toHaveBeenCalledWith("acme.com");
    expect(connect).not.toHaveBeenCalled();
    expect(screen.queryByText(/drafted you a reply to a warm lead/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^connected$/i)).not.toBeInTheDocument();
  });

  it("walks the whole flow: read → finding → guided connects each with a real payoff → ship", async () => {
    const onEnterApp = vi.fn();
    render(<OnboardingExperience provider={fakeProvider()} hour={14} onEnterApp={onEnterApp} />);

    // Door → reading: the fleet wakes, reads the real site, narrates the finding.
    fireEvent.change(screen.getByLabelText(/what are we marketing today/i), {
      target: { value: "acme.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /start/i }));
    expect((await screen.findAllByText(/buries the offer below the fold/i)).length).toBeGreaterThan(0);
    expect(screen.getByText(/right, i read the whole thing/i)).toBeInTheDocument();

    // → connect: gmail first. Allow → an IMMEDIATE real reply payoff.
    fireEvent.click(screen.getByRole("button", { name: /plug in your actual stuff/i }));
    expect(screen.getByText(/lend us your gmail/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^allow$/i }));
    expect(await screen.findByText(/drafted you a reply to a warm lead/i)).toBeInTheDocument();
    expect(screen.getByText(/priya@brightfox\.io/)).toBeInTheDocument();

    // reddit/x next → 3 helpful threads.
    expect(screen.getByText(/peek at reddit and x/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^allow$/i }));
    expect(await screen.findByText(/found 3 threads/i)).toBeInTheDocument();

    // the site → rewritten hero.
    expect(screen.getByText(/keys to your site/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^allow$/i }));
    expect(await screen.findByText(/here's your hero, rewritten/i)).toBeInTheDocument();

    // → the first real deliverable, with its honest "what happens if you say yes" line.
    fireEvent.click(screen.getByRole("button", { name: /watch this/i }));
    expect(await screen.findByText(/Acme's new hero/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing's sent and nothing's charged/i)).toBeInTheDocument();

    // One approve → it ships → the earned delight.
    fireEvent.click(screen.getByRole("button", { name: /ship it/i }));
    expect(await screen.findByText(/that's a real thing you just did/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /take me in/i }));
    expect(onEnterApp).toHaveBeenCalledTimes(1);
  });

  it("does not fake a connected state when the live connector is unavailable", async () => {
    const onEnterApp = vi.fn();
    const provider = fakeProvider({
      connect: () =>
        Promise.reject(new Error("gmail needs the real connections panel before ipop can use it.")),
    });
    render(<OnboardingExperience provider={provider} hour={14} onEnterApp={onEnterApp} />);

    fireEvent.change(screen.getByLabelText(/what are we marketing today/i), {
      target: { value: "acme.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /start/i }));
    fireEvent.click(await screen.findByRole("button", { name: /plug in your actual stuff/i }));
    fireEvent.click(screen.getByRole("button", { name: /^allow$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/needs the real connections panel/i);
    expect(screen.queryByText(/drafted you a reply to a warm lead/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^connected$/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /open real connections/i }));
    expect(onEnterApp).toHaveBeenCalledTimes(1);
  });

  it("reject is a take-two, not a dead end (rebuilds the deliverable)", async () => {
    let built = 0;
    const provider = fakeProvider({
      buildDeliverable: () => {
        built += 1;
        return Promise.resolve({ title: `draft ${built}`, body: "x", spendsMoney: false });
      },
    });
    render(<OnboardingExperience provider={provider} hour={14} />);
    fireEvent.change(screen.getByLabelText(/what are we marketing today/i), {
      target: { value: "acme.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /start/i }));
    fireEvent.click(await screen.findByRole("button", { name: /plug in your actual stuff/i }));
    fireEvent.click(screen.getByRole("button", { name: /^allow$/i }));
    await screen.findByText(/drafted you a reply/i);
    fireEvent.click(screen.getByRole("button", { name: /^allow$/i }));
    await screen.findByText(/found 3 threads/i);
    fireEvent.click(screen.getByRole("button", { name: /^allow$/i }));
    await screen.findByText(/here's your hero/i);
    fireEvent.click(screen.getByRole("button", { name: /watch this/i }));

    expect(await screen.findByText("draft 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /nah, redo/i }));
    expect(screen.getByText(/take two/i)).toBeInTheDocument();
    expect(await screen.findByText("draft 2")).toBeInTheDocument();
  });

  it("shows the hard money gate when the deliverable would actually spend", async () => {
    const provider = fakeProvider({
      readSite: () => Promise.resolve(FINDING),
      buildDeliverable: () =>
        Promise.resolve({ title: "a paid boost", body: "x", spendsMoney: true }),
    });
    render(<OnboardingExperience provider={provider} hour={14} />);
    fireEvent.change(screen.getByLabelText(/what are we marketing today/i), {
      target: { value: "acme.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /start/i }));
    fireEvent.click(await screen.findByRole("button", { name: /plug in your actual stuff/i }));
    fireEvent.click(screen.getByRole("button", { name: /^allow$/i }));
    await screen.findByText(/drafted you a reply/i);
    fireEvent.click(screen.getByRole("button", { name: /^allow$/i }));
    await screen.findByText(/found 3 threads/i);
    fireEvent.click(screen.getByRole("button", { name: /^allow$/i }));
    await screen.findByText(/here's your hero/i);
    fireEvent.click(screen.getByRole("button", { name: /watch this/i }));
    expect(await screen.findByText(/this one costs actual money/i)).toBeInTheDocument();
  });

  it("degrades honestly when the site can't be read, then retries", async () => {
    let calls = 0;
    const provider = fakeProvider({
      readSite: () => {
        calls += 1;
        if (calls === 1)
          return Promise.reject(new OnboardingReadError("we couldn't read your site just now."));
        return Promise.resolve(FINDING);
      },
    });
    render(<OnboardingExperience provider={provider} hour={14} />);
    fireEvent.change(screen.getByLabelText(/what are we marketing today/i), {
      target: { value: "acme.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /start/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't read your site/i);
    expectPublicLinks();
    // No faked finding while it's errored.
    expect(screen.queryByText(/buries the offer/i)).not.toBeInTheDocument();
    // Retry recovers.
    fireEvent.click(screen.getByRole("button", { name: /start/i }));
    expect((await screen.findAllByText(/buries the offer/i)).length).toBeGreaterThan(0);
  });
});
