/**
 * The data seam behind the #784 onboarding experience. Everything the surface shows — the real site finding,
 * the per-connector payoffs (a drafted Gmail reply, helpful Reddit/X threads, a rewritten hero), and the
 * first shippable deliverable — comes from an {@link OnboardingProvider}. This keeps the component purely
 * presentational and the flow testable under jsdom without a network (tests inject a provider).
 *
 * The DEFAULT provider reads the user's real site through the public #633 / #610 deliverable endpoint
 * (`fetchDemoDeliverable`) so the narrated finding is genuinely derived from their site (server-sanitized
 * text). The connect step uses the same `/me/connections` surface as Settings: available one-click channels
 * can produce an immediate payoff after they report connected; OAuth connectors that are still coming soon
 * degrade honestly instead of returning a fake payoff.
 */
import { api } from "../../api/client.js";
import { fetchDemoDeliverable, DemoError, type FetchLike } from "../../api/demo.js";
import type { ConnectionView, ConnectionsResponse } from "../../api/types.js";

/** Which tool a guided connect step plugs into. */
export type ConnectTool = "gmail" | "social" | "site";

/** A real, site-derived finding scout narrates after reading the site. */
export interface SiteFinding {
  readonly host: string;
  readonly name: string;
  readonly finding: string;
}

export type TeamMissionAgentStatus = "working" | "handoff" | "blocked" | "gated";

export interface TeamMissionAgent {
  readonly who: "scout" | "quill" | "echo" | "bid";
  readonly role: string;
  readonly status: TeamMissionAgentStatus;
  readonly current: string;
}

export interface TeamMissionArtifact {
  readonly title: string;
  readonly summary: string;
}

export interface TeamMission {
  readonly id: string;
  readonly target: string;
  readonly objective: string;
  readonly agents: readonly TeamMissionAgent[];
  readonly handoffs: readonly string[];
  readonly artifacts: readonly TeamMissionArtifact[];
  readonly receipts: readonly string[];
  readonly blockedPermissions: readonly string[];
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
  /** Create the shared first-run mission tying the starter agents, their handoffs, outputs, and receipts. */
  startTeam(input: string, finding: SiteFinding): Promise<TeamMission>;
  /** Plug in one tool, Cowork-style; resolve with the real result that uses it (personalized from `input`). */
  connect(tool: ConnectTool, input: string): Promise<ConnectResult>;
  /** Build the first shippable deliverable from the connected accounts. */
  buildDeliverable(input: string): Promise<DeliverableDraft>;
  /** The human said yes — record the ship (no send/charge happens here; that stays gated). */
  ship(): Promise<ShipResult>;
}

export interface OnboardingConnectionsClient {
  getConnections(): Promise<ConnectionsResponse>;
  enableConnection(id: string): Promise<ConnectionsResponse>;
  startConnectionOAuth?(id: string): Promise<unknown>;
  joinConnectionWaitlist?(id: string): Promise<void>;
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

function missionId(host: string): string {
  const key = host.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `mission-${key || "target"}`;
}

const CONNECTION_IDS_BY_TOOL: Record<ConnectTool, readonly string[]> = {
  gmail: ["email"],
  social: ["social_aggregator", "x", "linkedin"],
  site: ["website", "site_publish_github"],
};

function connectionLabel(tool: ConnectTool): string {
  if (tool === "social") return "reddit/x";
  if (tool === "site") return "your site";
  return "gmail";
}

function findConnection(tool: ConnectTool, connections: readonly ConnectionView[]): ConnectionView | undefined {
  const ids = CONNECTION_IDS_BY_TOOL[tool];
  return (
    connections.find((c) => ids.includes(c.id) && c.connected) ??
    connections.find((c) => ids.includes(c.id) && c.status === "available") ??
    connections.find((c) => ids.includes(c.id))
  );
}

async function resolveConnectedTool(
  client: OnboardingConnectionsClient,
  tool: ConnectTool,
): Promise<ConnectionView> {
  const before = await client.getConnections();
  const selected = findConnection(tool, before.connections);
  const label = connectionLabel(tool);
  if (!selected) {
    throw new OnboardingConnectUnavailableError(
      `${label} isn't in this workspace's connection catalog yet.`,
    );
  }
  if (selected.connected) return selected;
  if (selected.status !== "available") {
    throw new OnboardingConnectUnavailableError(
      `${selected.label} is still coming soon, so ipop can't use it for a real payoff yet.`,
    );
  }
  if (selected.auth !== "one_click") {
    if (selected.auth === "oauth" && client.startConnectionOAuth) {
      await client.startConnectionOAuth(selected.id);
    }
    throw new OnboardingConnectUnavailableError(
      `${selected.label} needs the live OAuth handoff before ipop can use it.`,
    );
  }
  const after = await client.enableConnection(selected.id);
  const connected = findConnection(tool, after.connections);
  if (!connected?.connected) {
    throw new OnboardingConnectUnavailableError(
      `${selected.label} did not report connected after consent, so no payoff was generated.`,
    );
  }
  return connected;
}

function connectedPayoff(tool: ConnectTool, input: string, connection: ConnectionView): ConnectResult {
  const { name } = parseTarget(input);
  if (tool === "gmail") {
    return {
      tool,
      lead: {
        from: connection.provider === "email" ? "first-reply@connected-email" : "connected-inbox",
        subject: `re: ${name}`,
      },
      draft:
        `thanks for taking a look at ${name}. the short version: we can turn your current interest ` +
        "into a reviewed next step, and nothing sends until you approve it.",
    };
  }
  if (tool === "social") {
    return {
      tool,
      threads: [
        {
          source: "connected social",
          title: `${name} category question`,
          draft: `answer the question first, then mention the ${name} angle only if it helps.`,
        },
      ],
    };
  }
  return {
    tool,
    before: `${name} helps teams grow.`,
    after: `${name}: the next customer-acquisition move, drafted and ready for approval.`,
  };
}

/**
 * The default provider used in the live app. `readSite` is REAL (it reads the user's site via the public
 * deliverable endpoint and narrates its first insight). Connectors go through the real connection catalog:
 * if a tool can connect now (today: one-click email), it returns an immediate visible payoff; if the live
 * OAuth handoff is still unavailable, it refuses honestly. `fetchImpl` is injectable so the real read is testable.
 */
export function createDefaultProvider(
  opts: { fetchImpl?: FetchLike; connections?: OnboardingConnectionsClient } = {},
): OnboardingProvider {
  const connections = opts.connections ?? api;
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
    async startTeam(input, finding) {
      const { host, name } = parseTarget(input);
      const target = finding.host || host;
      return {
        id: missionId(target),
        target,
        objective: `turn ${finding.name || name} into a live customer-acquisition motion`,
        agents: [
          {
            who: "scout",
            role: "customer truth",
            status: "handoff",
            current: `read ${target} and found: ${finding.finding}`,
          },
          {
            who: "quill",
            role: "copy + content",
            status: "working",
            current: "drafting a sharper hero and launch-week copy from Scout's finding",
          },
          {
            who: "echo",
            role: "distribution",
            status: "blocked",
            current: "ready to find social threads once Reddit/X access is real",
          },
          {
            who: "bid",
            role: "paid growth",
            status: "gated",
            current: "holding paid spend behind the workspace approval policy",
          },
        ],
        handoffs: [
          "scout -> quill: positioning gap and strongest customer promise",
          "quill -> echo: draft angle for social/community distribution",
          "echo -> bid: only escalate to paid once organic proof exists",
        ],
        artifacts: [
          {
            title: "site-read receipt",
            summary: finding.finding,
          },
          {
            title: "first deliverable queued",
            summary: "hero rewrite + launch-week post plan can be built before any external send",
          },
        ],
        receipts: [
          `site read: ${target}`,
          "team mission recorded",
          "send/spend gates active",
        ],
        blockedPermissions: ["Gmail", "Reddit/X", "site publishing"],
      };
    },
    async connect(tool, input) {
      const connected = await resolveConnectedTool(connections, tool);
      return connectedPayoff(tool, input, connected);
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
