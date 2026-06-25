import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OnboardingExperience } from "./OnboardingExperience.js";
import { ipopExperienceTokens } from "../../design/ipop-experience-tokens.js";
import type {
  ConnectResult,
  ConnectTool,
  DeliverableDraft,
  OnboardingProvider,
  SiteFinding,
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

function payoff(tool: ConnectTool): ConnectResult {
  if (tool === "gmail") {
    return { tool, lead: { from: "priya@brightfox.io", subject: "re: team plans?" }, draft: "hi priya — yes we do." };
  }
  if (tool === "social") {
    return {
      tool,
      threads: [
        { source: "r/marketing", title: "best tool for a tiny team?", draft: "be helpful, not salesy." },
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
    connect: (tool) => Promise.resolve(payoff(tool)),
    buildDeliverable: (): Promise<DeliverableDraft> =>
      Promise.resolve({ title: "Acme's new hero + a launch week", body: "all from your real accounts.", spendsMoney: false }),
    ship: () => Promise.resolve({ shipped: true as const }),
    ...over,
  };
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

  it("opens on the warm door — a personalized greeting and ONE input, nothing else", () => {
    render(<OnboardingExperience provider={fakeProvider()} hour={14} name="gagan" />);
    expect(screen.getByText(/afternoon, gagan/i)).toBeInTheDocument();
    expect(screen.getByText(/what are we making pop today/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/what are we marketing today/i)).toBeInTheDocument();
    // No agent thread / connect prompts on the door.
    expect(screen.queryByText(/lend us your gmail/i)).not.toBeInTheDocument();
  });

  it("nudges (does not advance) on an empty submit", () => {
    render(<OnboardingExperience provider={fakeProvider()} hour={9} />);
    fireEvent.click(screen.getByRole("button", { name: /let's go/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/give us a product or a url/i);
  });

  it("walks the whole flow: read → finding → guided connects each with a real payoff → ship", async () => {
    const onEnterApp = vi.fn();
    render(<OnboardingExperience provider={fakeProvider()} hour={14} onEnterApp={onEnterApp} />);

    // Door → reading: the fleet wakes, reads the real site, narrates the finding.
    fireEvent.change(screen.getByLabelText(/what are we marketing today/i), { target: { value: "acme.com" } });
    fireEvent.click(screen.getByRole("button", { name: /let's go/i }));
    expect(await screen.findByText(/buries the offer below the fold/i)).toBeInTheDocument();
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

  it("reject is a take-two, not a dead end (rebuilds the deliverable)", async () => {
    let built = 0;
    const provider = fakeProvider({
      buildDeliverable: () => {
        built += 1;
        return Promise.resolve({ title: `draft ${built}`, body: "x", spendsMoney: false });
      },
    });
    render(<OnboardingExperience provider={provider} hour={14} />);
    fireEvent.change(screen.getByLabelText(/what are we marketing today/i), { target: { value: "acme.com" } });
    fireEvent.click(screen.getByRole("button", { name: /let's go/i }));
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
      buildDeliverable: () => Promise.resolve({ title: "a paid boost", body: "x", spendsMoney: true }),
    });
    render(<OnboardingExperience provider={provider} hour={14} />);
    fireEvent.change(screen.getByLabelText(/what are we marketing today/i), { target: { value: "acme.com" } });
    fireEvent.click(screen.getByRole("button", { name: /let's go/i }));
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
        if (calls === 1) return Promise.reject(new OnboardingReadError("we couldn't read your site just now."));
        return Promise.resolve(FINDING);
      },
    });
    render(<OnboardingExperience provider={provider} hour={14} />);
    fireEvent.change(screen.getByLabelText(/what are we marketing today/i), { target: { value: "acme.com" } });
    fireEvent.click(screen.getByRole("button", { name: /let's go/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't read your site/i);
    // No faked finding while it's errored.
    expect(screen.queryByText(/buries the offer/i)).not.toBeInTheDocument();
    // Retry recovers.
    fireEvent.click(screen.getByRole("button", { name: /let's go/i }));
    expect(await screen.findByText(/buries the offer/i)).toBeInTheDocument();
  });
});
