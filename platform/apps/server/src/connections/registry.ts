/**
 * The OAuth-first connection model (#258). A "connection" is a one-time CONSENT that lets the fleet act
 * through an outside account — the only human-in-the-loop step besides spending money. ipop's customers
 * are non-technical, so the model is shaped around consumer OAuth ("Sign in with Google", "Connect X"),
 * NEVER a paste-a-token. The sole paste path is `paste_internal`: ipop's OWN site-publish mechanism
 * (committing to ipop.ai's repo), which is admin/internal and never offered to a customer.
 *
 * This module is pure data + selectors. The live OAuth redirect flow is a follow-up; the descriptors are
 * already OAuth-shaped (provider, scopes, capabilities) so the redirect slots in behind the same model,
 * and the Settings UI can render the consumer "Connect" buttons today (as `coming_soon`).
 */

import type { ServiceKind } from "../onboarding/types.js";

/** How a connection's consent is obtained. */
export type ConnectionAuthMethod =
  /** Consumer OAuth — the customer-facing default ("Sign in with Google", "Connect X"). */
  | "oauth"
  /**
   * A one-click customer consent that needs neither a redirect nor a pasted secret — the customer simply
   * turns a channel the fleet already owns end-to-end ON for their workspace. The first is outbound email
   * (#529): the agents can draft and queue a real email, and every send waits for the owner's approval. Like
   * OAuth it never asks the customer for a token, so it honours the "customers never paste a credential" rule.
   */
  | "one_click"
  /** A pasted credential, INTERNAL/admin only (ipop's own GitHub site-publish). Never customer-facing. */
  | "paste_internal";

/** Who a connection is offered to. */
export type ConnectionAudience = "customer" | "internal";

/** Whether the live connect flow is wired yet. */
export type ConnectionStatus = "available" | "coming_soon";

export interface ConnectionDescriptor {
  /** Stable id — also the `service_key` used in the #192 vault and the connect routes. */
  id: string;
  /** Button/card label, e.g. "Sign in with Google", "Connect your website". */
  label: string;
  /** One-line description shown under the connect button. */
  summary: string;
  /** The external provider, e.g. `google`, `github`, `x`, `linkedin`, `webflow`. */
  provider: string;
  /** Reuses the onboarding service kinds so the readiness signal (#231) keeps working. */
  kind: ServiceKind;
  audience: ConnectionAudience;
  auth: ConnectionAuthMethod;
  status: ConnectionStatus;
  /** The real-world capabilities this one consent unlocks (e.g. `search_console`, `post_social`). */
  capabilities: string[];
  /** OAuth scopes the consent covers (empty for paste connections). */
  oauthScopes: string[];
  /** Env var names the agents resolve once connected (paste connections seal these into the vault). */
  envKeys: string[];
}

/** The internal GitHub site-publish connection id (ipop.ai's own mechanism — admin only). */
export const SITE_PUBLISH_GITHUB_ID = "site_publish_github";

/** The connect-once SOCIAL AGGREGATOR connection id (#269 — one consent fans out to every network). */
export const SOCIAL_AGGREGATOR_ID = "social_aggregator";

/** The outbound-email connection id (#529 — the first real end-to-end outbound channel; one-click consent). */
export const EMAIL_CONNECTION_ID = "email";

/** The onboarding website consent id (#1070 — lets Quill produce an immediate hero rewrite). */
export const WEBSITE_CONNECTION_ID = "website";

export const CONNECTION_DESCRIPTORS: readonly ConnectionDescriptor[] = [
  // -------------------------------------------------------------------------------------------------
  // INTERNAL — ipop.ai's own publishing mechanism. A customer NEVER sees this; it exists only so ipop
  // can publish to its own site repo without a Fly server secret (the token lives in the encrypted
  // per-workspace connection instead).
  // -------------------------------------------------------------------------------------------------
  {
    id: SITE_PUBLISH_GITHUB_ID,
    label: "Site publishing (internal)",
    summary: "ipop.ai's own publishing — commit content + open a PR against the ipop site repo.",
    provider: "github",
    kind: "hosting",
    audience: "internal",
    auth: "paste_internal",
    status: "available",
    capabilities: ["site_publish"],
    oauthScopes: [],
    envKeys: ["REALWORLD_GITHUB_TOKEN", "REALWORLD_SITE_REPO", "REALWORLD_SITE_BASE_BRANCH"],
  },

  // -------------------------------------------------------------------------------------------------
  // CUSTOMER — consumer OAuth, one consent each. The live redirect is a follow-up (`coming_soon`), but
  // the model is already OAuth-shaped so it slots in without re-modelling.
  //
  // Outbound EMAIL is the exception: it's the first channel wired end-to-end (#529), so it is `available`
  // today. Turning it on is a one-click consent — no redirect, no pasted secret — and every email the fleet
  // sends still waits for the owner's approval. This is the connector that lets a fresh workspace finish the
  // "connect an account" step instead of dead-ending on a wall of "coming soon".
  // -------------------------------------------------------------------------------------------------
  {
    id: EMAIL_CONNECTION_ID,
    label: "Connect email",
    summary:
      "Let your fleet send email on your behalf — drafts come to you, and every send waits for your approval.",
    provider: "email",
    kind: "esp",
    audience: "customer",
    auth: "one_click",
    status: "available",
    capabilities: ["send_email"],
    oauthScopes: [],
    envKeys: [],
  },
  {
    id: "google",
    label: "Sign in with Google",
    summary:
      "One consent connects Search Console + Analytics — Scout owns verification, sitemaps & indexing.",
    provider: "google",
    kind: "analytics",
    audience: "customer",
    auth: "oauth",
    status: "coming_soon",
    capabilities: ["search_console", "analytics"],
    oauthScopes: [
      "https://www.googleapis.com/auth/webmasters",
      "https://www.googleapis.com/auth/analytics.readonly",
    ],
    envKeys: [],
  },
  {
    id: WEBSITE_CONNECTION_ID,
    label: "Connect your website",
    summary:
      "Let Quill draft against your site right now — publishing still waits for the owner approval.",
    provider: "website",
    kind: "hosting",
    audience: "customer",
    auth: "one_click",
    status: "available",
    capabilities: ["site_publish"],
    oauthScopes: [],
    envKeys: [],
  },
  {
    id: "x",
    label: "Connect X",
    summary: "Echo posts to your X account — connect once, real spend stays approval-gated.",
    provider: "x",
    kind: "ad_account",
    audience: "customer",
    auth: "oauth",
    status: "coming_soon",
    capabilities: ["post_social"],
    oauthScopes: ["tweet.read", "tweet.write", "users.read"],
    envKeys: [],
  },
  {
    id: "linkedin",
    label: "Connect LinkedIn",
    summary: "Echo posts to your LinkedIn page — connect once, real spend stays approval-gated.",
    provider: "linkedin",
    kind: "ad_account",
    audience: "customer",
    auth: "oauth",
    status: "coming_soon",
    capabilities: ["post_social"],
    oauthScopes: ["w_member_social"],
    envKeys: [],
  },
  {
    // #269 the connect-once SOCIAL AGGREGATOR bridge: ONE consent fans Echo's posts out to every network
    // (X, LinkedIn, Instagram, TikTok, Facebook) — the customer never touches a per-platform developer
    // portal. Every post stays behind the #13 owner approval (a post is irreversible).
    id: SOCIAL_AGGREGATOR_ID,
    label: "Connect your social accounts",
    summary:
      "One consent lets Echo find Reddit/X threads and draft replies — every post still owner-approved.",
    provider: "social_aggregator",
    kind: "ad_account",
    audience: "customer",
    auth: "one_click",
    status: "available",
    capabilities: ["post_social"],
    oauthScopes: [],
    envKeys: [],
  },
  {
    // #272 — Bid's one-click ad account connect. One OAuth consent connects Google Ads (with billing in
    // place on the customer's own account); Bid manages campaigns through it, but EVERY real spend stays a
    // #13 money-gated owner yes (ADR-0272). The live redirect is a follow-up, so it renders `coming_soon`.
    id: "google_ads",
    label: "Connect Google Ads",
    summary:
      "One consent lets Bid run campaigns on your ad account — every spend stays your money-gated yes.",
    provider: "google",
    kind: "ad_account",
    audience: "customer",
    auth: "oauth",
    status: "coming_soon",
    capabilities: ["ads"],
    oauthScopes: ["https://www.googleapis.com/auth/adwords"],
    envKeys: [],
  },
  {
    // #885 — Meta Ads is a paid-ad account connector, separate from the social-posting aggregator. It unlocks
    // the same Bid ads capability; every proposed spend still parks a #13 money approval before execution.
    id: "meta_ads",
    label: "Connect Meta Ads",
    summary:
      "One consent lets Bid read Meta campaigns and propose paid reach — every spend stays your money-gated yes.",
    provider: "meta",
    kind: "ad_account",
    audience: "customer",
    auth: "oauth",
    status: "coming_soon",
    capabilities: ["ads"],
    oauthScopes: ["ads_read", "ads_management", "business_management"],
    envKeys: [],
  },
];

const BY_ID: ReadonlyMap<string, ConnectionDescriptor> = new Map(
  CONNECTION_DESCRIPTORS.map((d) => [d.id, d]),
);

/** Look up a connection descriptor by id. */
export function getConnectionDescriptor(id: string): ConnectionDescriptor | undefined {
  return BY_ID.get(id);
}

/** List descriptors, optionally filtered by audience. */
export function listConnectionDescriptors(
  opts: { audience?: ConnectionAudience } = {},
): ConnectionDescriptor[] {
  return CONNECTION_DESCRIPTORS.filter((d) => !opts.audience || d.audience === opts.audience);
}
