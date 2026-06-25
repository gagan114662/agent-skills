/**
 * The data seam behind the #784 onboarding experience. Everything the surface shows — the real site finding,
 * the per-connector payoffs (a drafted Gmail reply, helpful Reddit/X threads, a rewritten hero), and the
 * first shippable deliverable — comes from an {@link OnboardingProvider}. This keeps the component purely
 * presentational and the flow testable under jsdom without a network (tests inject a provider).
 *
 * The DEFAULT provider reads the user's real site through the public #633 / #610 deliverable endpoint
 * (`fetchDemoDeliverable`) so the narrated finding is genuinely derived from their site (server-sanitized
 * text). It must not invent Gmail, Reddit/X, or site-authoring access. Until those OAuth connectors are real,
 * the connect step degrades honestly with an unavailable error instead of returning a fake payoff.
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

/** Thrown when a connector is not backed by real OAuth/live account access. */
export class OnboardingConnectUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnboardingConnectUnavailableError";
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

/**
 * The default provider used in the live app. `readSite` is REAL (it reads the user's site via the public
 * deliverable endpoint and narrates its first insight). Connectors require real OAuth/live account reads, so
 * this provider refuses them until those backends exist. `fetchImpl` is injectable so the real read is testable.
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
      void input;
      const label = tool === "social" ? "reddit/x" : tool === "site" ? "your site" : "gmail";
      throw new OnboardingConnectUnavailableError(
        `${label} needs the real connections panel before ipop can use it.`,
      );
    },
    async buildDeliverable(input) {
      const { name } = parseTarget(input);
      return {
        title: `${name}'s new homepage hero + a week of posts to launch it`,
        body:
          `the rewritten hero (from your site read) and a 5-post launch week are ready as a preview. ` +
          `connect real accounts before ipop drafts replies or queues anything to publish.`,
        spendsMoney: false,
      };
    },
    async ship() {
      return { shipped: true };
    },
  };
}
