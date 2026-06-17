/**
 * Provider-response quarantine (issue #267, premortem #200 §6 — injection defense). The whole point of
 * central provisioning is to let the fleet READ from paid third-party APIs (keyword/SERP data, social
 * audience data, ads stats). That data is UNTRUSTED web-derived content: a poisoned SERP snippet or
 * profile bio must never steer an autonomous send or spend, and must never redirect which provider/
 * credential a later call uses.
 *
 * This module is the structural boundary every per-department adapter (#268 etc.) wraps a provider
 * response in before handing it to the fleet. A {@link QuarantinedProviderResult} is DATA ONLY: it carries
 * the structural provider id (so the caller knows what it metered) + a sanitized payload, and it exposes
 * NO send/spend/gate capability. The provider id is set by the CALLER from the structural routing
 * decision — never parsed out of the response body — so a response can never claim to be from a different
 * provider. Mirrors the #223 `QuarantinedProfileReader` pattern.
 */

/** Max characters of any free-text field surfaced from a provider response (a citation, not a dossier). */
export const MAX_PROVIDER_TEXT_CHARS = 500;

/**
 * Neutralize untrusted provider free text into safe data: strip control characters, collapse whitespace,
 * truncate. Defense-in-depth — even though no consumer parses this for directives, raw unbounded provider
 * content is never stored or surfaced. A non-string input (a provider returning `null`/a number for a text
 * field) yields `""` rather than throwing — the boundary must never crash on hostile/malformed input.
 */
export function sanitizeProviderText(text: string | null | undefined): string {
  if (typeof text !== "string") return "";
  return (
    text
      // eslint-disable-next-line no-control-regex -- intentionally stripping control chars from provider text
      .replace(/[\x00-\x1f\x7f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_PROVIDER_TEXT_CHARS)
  );
}

/**
 * A quarantined provider response. `provider` is the STRUCTURAL provider id from the routing decision
 * (never read from `data`); `data` is the typed, caller-sanitized payload. The type carries no method that
 * could act — it is inert data by construction, so a poisoned payload can reach a human/brief but never an
 * action. Adapters build it via {@link quarantineProviderResult}.
 */
export interface QuarantinedProviderResult<T> {
  readonly quarantined: true;
  readonly provider: string;
  readonly capabilityId: string;
  readonly data: T;
}

/**
 * Wrap a typed provider payload as quarantined DATA. The `provider`/`capabilityId` come from the caller's
 * structural routing decision; `data` is whatever the adapter already parsed + sanitized. Total + pure.
 */
export function quarantineProviderResult<T>(
  capabilityId: string,
  provider: string,
  data: T,
): QuarantinedProviderResult<T> {
  return { quarantined: true, provider, capabilityId, data };
}
