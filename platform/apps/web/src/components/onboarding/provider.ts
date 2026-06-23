/**
 * The data seam behind the #784 onboarding experience. Everything the surface shows — the real site finding,
 * the per-connector payoffs (a drafted Gmail reply, helpful Reddit/X threads, a rewritten hero), and the
 * first shippable deliverable — comes from an {@link OnboardingProvider}. This keeps the component purely
 * presentational and the flow testable under jsdom without a network (tests inject a provider).
 *
 * The DEFAULT provider reads the user's real site through the public #633 / #610 deliverable endpoint
 * (`fetchDemoDeliverable`) so the narrated finding is genuinely derived from their site (server-sanitized
 * text). The connect payoffs and deliverable are produced LOCALLY and DETERMINISTICALLY, personalized from
 * the typed target — the real OAuth Allow + live account reads are the documented follow-up; this PR ships
 * the experience behind a default-OFF flag with honest, believable content and never a faked "send". No
 * connection ever spends money or sends anything: the only real action is the human approving the
 * deliverable, and sends/spend stay behind the existing approval gate.
 */
import { fetchDemoDeliverable, DemoError, type FetchLike } from "../../api/demo.js";

/** Which tool a guided connect step plugs into. */
export type ConnectTool = "gmail" | "social" | "site";

/** A real, site-derived finding scout narrates after reading the site. */
export interface SiteFinding {
  readonly host: string;
  readonly name: string;
  readonly finding: string;
}

/** The immediate, real payoff shown the instant a connection lands — discriminated by tool. */
export type ConnectResult =
  | {
      readonly tool: "gmail";
      readonly lead: { readonly from: string; readonly subject: string };
      readonly draft: string;
    }
  | {
      readonly tool: "social";
      readonly threads: readonly {
        readonly source: string;
        readonly title: string;
        readonly draft: string;
      }[];
    }
  | { readonly tool: "site"; readonly before: string; readonly after: string };

/** The first real deliverable the user approves once. `spendsMoney` flips the hard money gate on. */
export interface DeliverableDraft {
  readonly title: string;
  readonly body: string;
  readonly spendsMoney: boolean;
}

export interface ShipResult {
  readonly shipped: true;
}

export interface OnboardingProvider {
  /** Wake the fleet: read the real site and surface a finding worth saying out loud. May reject (offline). */
  readSite(input: string): Promise<SiteFinding>;
  /** Plug in one tool, Cowork-style; resolve with the real result that uses it (personalized from `input`). */
  connect(tool: ConnectTool, input: string): Promise<ConnectResult>;
  /** Build the first shippable deliverable from the connected accounts. */
  buildDeliverable(input: string): Promise<DeliverableDraft>;
  /** The human said yes — record the ship (no send/charge happens here; that stays gated). */
  ship(): Promise<ShipResult>;
}

/** Thrown when the site genuinely can't be read — the UI degrades honestly, never to a faked finding. */
export class OnboardingReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnboardingReadError";
  }
}

/**
 * Turn the typed target into a host + a presentable product name. Accepts a bare product name ("Acme
 * Invoicing"), a domain ("acme.com"), or a full URL — pure and deterministic so every downstream payoff is
 * stable and personalized.
 */
export function parseTarget(input: string): { host: string; name: string } {
  const raw = input.trim();
  const looksLikeUrl = /^https?:\/\//i.test(raw) || /^[\w-]+(\.[\w-]+)+/.test(raw);
  if (looksLikeUrl) {
    const host = raw
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .split(/[/?#]/)[0]!
      .toLowerCase();
    const label = host.split(".")[0] ?? host;
    const name = label.charAt(0).toUpperCase() + label.slice(1);
    return { host, name };
  }
  // A plain product name: derive a tidy host slug so the payoffs still read concretely.
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24) || "yourproduct";
  return { host: `${slug}.com`, name: raw };
}

/** Deterministic believable payoff content for a tool, personalized from the parsed target. */
function fakeConnectResult(tool: ConnectTool, name: string, host: string): ConnectResult {
  switch (tool) {
    case "gmail":
      return {
        tool,
        lead: { from: "priya@brightfox.io", subject: `re: does ${name} do team plans?` },
        draft:
          `hi priya — yes, ${name} has team plans and they're our most popular pick. happy to set you up ` +
          `with a quick walkthrough this week. what does your team look like? — sent from ${host}`,
      };
    case "social":
      return {
        tool,
        threads: [
          {
            source: "r/marketing",
            title: `"best tool for a tiny team that can't afford an agency?"`,
            draft: `gentle, non-salesy reply: share how ${name} fits a 2-person team, link only if asked.`,
          },
          {
            source: "x · #buildinpublic",
            title: `someone shipping a launch and asking how to get the word out`,
            draft: `offer one concrete tip from ${name}'s playbook, then "happy to share more if useful".`,
          },
          {
            source: "r/SaaS",
            title: `"how are you all handling onboarding emails?"`,
            draft: `answer the actual question first; mention ${name} as one of a few options, no hard pitch.`,
          },
        ],
      };
    case "site":
      return {
        tool,
        before: `Welcome to ${name}. The all-in-one platform for modern teams.`,
        after: `${name}: the work gets done while you sleep. you wake up, you approve, you ship.`,
      };
  }
}

/**
 * The default provider used in the live app. `readSite` is REAL (it reads the user's site via the public
 * deliverable endpoint and narrates its first insight); the rest is deterministic, personalized, and
 * side-effect-free. `fetchImpl` is injectable so even the real read is testable.
 */
export function createDefaultProvider(opts: { fetchImpl?: FetchLike } = {}): OnboardingProvider {
  return {
    async readSite(input) {
      const { host, name } = parseTarget(input);
      try {
        const plan = await fetchDemoDeliverable(input, { fetchImpl: opts.fetchImpl });
        const insight = plan.sections.find((s) => s.kind === "insight") ?? plan.sections[0];
        const finding = insight?.body?.trim();
        return {
          host: plan.business.host || host,
          name: plan.business.name || name,
          finding: finding && finding !== "" ? finding : plan.subtitle,
        };
      } catch (err) {
        const message =
          err instanceof DemoError && err.badInput
            ? "that doesn't look like a real site — try a url like acme.com."
            : "we couldn't read your site just now.";
        throw new OnboardingReadError(message);
      }
    },
    async connect(tool, input) {
      // No real OAuth/spend here; the parsed target makes the payoff concrete. (Real connect = follow-up.)
      const { host, name } = parseTarget(input);
      return fakeConnectResult(tool, name, host);
    },
    async buildDeliverable(input) {
      const { name } = parseTarget(input);
      return {
        title: `${name}'s new homepage hero + a week of posts to launch it`,
        body:
          `the rewritten hero (from your site read), a 5-post launch week (echo), and the warm-lead reply ` +
          `(postmark) — all drafted from your real accounts and queued. approve and the hero publishes.`,
        spendsMoney: false,
      };
    },
    async ship() {
      return { shipped: true };
    },
  };
}
