/**
 * Egress domain allowlist — pure policy (issue #151, ADR-0151).
 *
 * #58 gave us a *binary* `dataPrivacyMode` (all off-platform egress on/off). #151 adds a per-workspace
 * **domain allowlist** for cloud agent sessions: when enabled, only listed domains are reachable and
 * everything else is denied + flagged. This module is pure — host parsing + the allow/deny/flag decision.
 * Enforcement (recording a violation, failing the action, injecting the list into the session) lives at
 * the seams that import it; the sandbox kernel-enforcement wire-up is a documented future seam (ADR-0151).
 *
 * Default-OFF by contract: `enabled: false` ⇒ every target is allowed (today's behavior, no allowlist).
 */

export type EgressDecisionKind = "allow" | "deny" | "flagged";

export interface EgressDecision {
  decision: EgressDecisionKind;
  /** The extracted host (lower-cased, port-stripped), or null when the target couldn't be parsed. */
  domain: string | null;
  reason?: string;
}

export interface EgressPolicyInput {
  /** The raw outbound target: a URL, a `host:port`, or a bare hostname. */
  target: string;
  /** Allowed domains: exact (`api.example.com`) or leading-wildcard (`*.example.com`). */
  allowlist: string[];
  /** When false (the default), egress is unrestricted — every target is allowed. */
  enabled: boolean;
}

/**
 * Extract the lower-cased, port-stripped host from a target. Accepts a full URL, a `scheme://host`,
 * a `host:port`, or a bare hostname. Returns null for an unparseable / empty target.
 */
export function domainOf(target: string): string | null {
  if (typeof target !== "string") return null;
  let s = target.trim();
  if (!s) return null;
  // Strip a scheme if present so the URL parser isn't required (and bare hosts still work).
  s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  // Drop any path/query/fragment, then any userinfo, then the port.
  s = s.split(/[/?#]/, 1)[0] ?? "";
  const at = s.lastIndexOf("@");
  if (at >= 0) s = s.slice(at + 1);
  // IPv6 in brackets: keep the bracketed host, drop a trailing :port outside the brackets.
  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    if (close >= 0) return s.slice(0, close + 1).toLowerCase();
  }
  s = s.split(":", 1)[0] ?? "";
  s = s.replace(/\.$/, ""); // trailing dot (FQDN root)
  return s ? s.toLowerCase() : null;
}

/** True iff `domain` matches an allowlist entry: exact, or a leading-`*.` wildcard (one+ label deep). */
export function matchesAllowlist(domain: string, allowlist: string[]): boolean {
  const d = domain.toLowerCase();
  for (const raw of allowlist) {
    const entry = raw.trim().toLowerCase().replace(/\.$/, "");
    if (!entry) continue;
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1); // ".example.com"
      // `*.example.com` matches `a.example.com` (and deeper) but NOT the apex `example.com`.
      if (d.endsWith(suffix) && d.length > suffix.length) return true;
    } else if (d === entry) {
      return true;
    }
  }
  return false;
}

/**
 * The pure egress decision. Disabled ⇒ `allow`. Enabled + parseable + in-list ⇒ `allow`. Enabled +
 * parseable + not-in-list ⇒ `deny`. Enabled + unparseable ⇒ `flagged` (suspicious, never silently
 * allowed). A `deny` is what a caller records as a violation; `flagged` is the "couldn't even tell" case.
 */
export function decideEgress(input: EgressPolicyInput): EgressDecision {
  const domain = domainOf(input.target);
  if (!input.enabled) return { decision: "allow", domain };
  if (domain === null) {
    return { decision: "flagged", domain: null, reason: "unparseable egress target" };
  }
  if (matchesAllowlist(domain, input.allowlist)) return { decision: "allow", domain };
  return { decision: "deny", domain, reason: "domain not in the workspace egress allowlist" };
}

/** Normalise a config allowlist: trim, lower-case, drop blanks/dupes — the stable form stored/injected. */
export function normaliseAllowlist(allowlist: string[] | undefined): string[] {
  const seen = new Set<string>();
  for (const raw of allowlist ?? []) {
    const e = raw.trim().toLowerCase().replace(/\.$/, "");
    if (e) seen.add(e);
  }
  return [...seen];
}

export interface ResolvedEgressPolicy {
  enabled: boolean;
  allowlist: string[];
}

/** Resolve the #58 config partial into the egress policy, defaulting to OFF (unrestricted egress). */
export function resolveEgressPolicy(
  config: { enabled?: boolean; allowlist?: string[] } | undefined,
): ResolvedEgressPolicy {
  return {
    enabled: config?.enabled ?? false,
    allowlist: normaliseAllowlist(config?.allowlist),
  };
}
