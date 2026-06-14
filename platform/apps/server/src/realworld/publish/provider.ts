/**
 * The publish provider seam (#231) — the concrete actuator behind the `publish` real-world tool. Takes
 * a slug + a self-contained HTML page and returns a live, reachable public URL. Dry-run by default (no
 * network, not reachable); a real provider (GitHub Pages) is opted in via config + a token.
 *
 * This is the narrow "HTML string → real URL" capability the platform was missing (#231): venture
 * deploys (#195) provisions infra but never had a path from a page's bytes to a reachable URL.
 */

export interface PublishInput {
  /** Tenant the artifact belongs to (audit/scoping). */
  workspaceId: string;
  /** Optional venture the page is for (soft-linked in the receipt). */
  ventureId?: string | null;
  /** DNS-safe slug — becomes the site/repo name and part of the URL. */
  slug: string;
  /** A complete, standalone HTML document to publish as `index.html`. */
  html: string;
  /** Progress log sink (redacted by the caller). */
  onLog: (line: string) => void;
}

export interface PublishOutcome {
  status: "ready" | "error";
  /** The live, reachable URL when `status === "ready"`. */
  url?: string;
  /** A provider-specific id (e.g. the repo full name) for audit. */
  providerId?: string;
  error?: string;
}

export interface PublishProvider {
  readonly kind: string;
  /** Publish the page and return a live URL (or an error outcome — never throws on a publish failure). */
  publish(input: PublishInput): Promise<PublishOutcome>;
  /** A reachability check (HEAD) used to PROVE the URL is live (#231 acceptance). */
  healthCheck(url: string): Promise<{ ok: boolean; status: number }>;
}
