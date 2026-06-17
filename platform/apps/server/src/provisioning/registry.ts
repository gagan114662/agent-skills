/**
 * Central provisioning catalog (issue #267, ADR-0267) — the SHARED seam the per-department adapters
 * (#265/#268/#269/#270/#272) build on. Real keyword/SERP data, social posting, and ads management sit
 * behind paid third-party APIs that need keys. ipop holds those keys CENTRALLY (one place, the owner/
 * platform vault) and bills the cost into the plan, so a customer never provisions or sees an API key.
 *
 * This module is PURE data + selectors. It names CAPABILITIES (what the fleet needs — "real keyword
 * data", "social posting") and the PROVIDERS that can fulfil each. It holds NO secrets and NO live
 * provider wiring: the real adapter + provider choice is the per-department PR's job. The catalog exists
 * so every department resolves a capability through one model (provider selection, central vault key,
 * cost class) instead of re-inventing parallel ones.
 *
 * Two invariants live in the SHAPE here, not by convention:
 *  - **Customer never sees a key.** A capability maps to a CENTRAL vault `service_key` (`central:<provider>`)
 *    held in the OWNER workspace — never a per-customer paste. {@link centralServiceKey}.
 *  - **Money boundary (#243).** Each capability declares a {@link CapabilityCostClass}: `platform_cost`
 *    (ipop's cost of goods, billed into the plan → autonomous) vs `customer_spend` (the customer's OWN
 *    money — ad budget, email sending tier → ALWAYS #13 money-gated). The issue's rule, encoded as data.
 */

/**
 * Who pays, and therefore whether the action is money-gated (#243, premortem #200 §4).
 *  - `platform_cost`: ipop pays the provider bill and bills it into the plan. The customer commits no
 *    money, so the fleet uses it AUTONOMOUSLY (no #13 gate). Real keyword/SERP data, social-posting infra,
 *    the ads-management API surface.
 *  - `customer_spend`: real money the CUSTOMER commits — their own ad budget, their email-sending tier.
 *    Irreversible (premortem §4), so it is ALWAYS owner-gated through the #13 money queue with the exact
 *    amount shown. This is the "yes that stays a money-gated yes" the issue calls out.
 */
export type CapabilityCostClass = "platform_cost" | "customer_spend";

/** A real-world capability the fleet needs, fulfilled centrally so the customer never provisions a key. */
export interface CapabilityDescriptor {
  /** Stable id the per-department adapters resolve against (e.g. `keyword_data`, `social_post`). */
  id: string;
  /** Human label for the read surface ("Real keyword data", "Social posting"). */
  label: string;
  /** One-line description of what the capability unlocks and which department consumes it. */
  summary: string;
  /** Who pays — drives the money gate. {@link CapabilityCostClass}. */
  costClass: CapabilityCostClass;
  /**
   * The provider ids that CAN fulfil this capability. Names only — never secrets. A per-department PR
   * selects the active one via config; the central key is resolved from the owner vault under
   * `central:<provider>`. Empty until a department wires a real adapter (a `customer_spend` capability
   * has no central provider — the customer's own account/budget fulfils it). The free `mock` provider is
   * always present so an un-provisioned workspace resolves to a dependency-free no-network stand-in.
   */
  providers: string[];
  /** The non-secret env-var names a resolved central credential supplies (documentation for adapters). */
  envKeys: string[];
}

/** The free, no-network stand-in provider — always available, costs nothing, makes no live call. */
export const MOCK_PROVIDER = "mock";

/**
 * The provisioning catalog. Provider lists are intentionally minimal: this PR ships the SEAM, not a live
 * integration. The per-department PRs append the real provider id + wire its adapter; this object is the
 * single place that mapping lives. Every `platform_cost` capability carries `mock` so the default
 * (un-provisioned, flag OFF) path resolves to a free no-network provider rather than failing.
 */
export const CAPABILITY_DESCRIPTORS: readonly CapabilityDescriptor[] = [
  // --- platform_cost: ipop pays, billed into the plan, used autonomously ---------------------------
  {
    id: "keyword_data",
    label: "Real keyword data",
    summary: "Scout/SEO reads real search-volume + difficulty data — billed into the plan, no key to paste.",
    costClass: "platform_cost",
    providers: [MOCK_PROVIDER],
    envKeys: [],
  },
  {
    id: "serp_data",
    label: "SERP & rank tracking",
    summary: "Scout/SEO reads live SERP positions for externally-grounded rank tracking (#294).",
    costClass: "platform_cost",
    providers: [MOCK_PROVIDER],
    envKeys: [],
  },
  {
    id: "social_post",
    label: "Social posting",
    summary: "Echo posts to the customer's connected (#258 OAuth) social accounts via ipop's posting API.",
    costClass: "platform_cost",
    providers: [MOCK_PROVIDER],
    envKeys: [],
  },
  {
    id: "ads_manage",
    label: "Ads management API",
    summary: "Bid manages campaigns through the ads API surface — the API access is billed into the plan.",
    costClass: "platform_cost",
    providers: [MOCK_PROVIDER],
    envKeys: [],
  },
  // --- customer_spend: the customer's OWN money — ALWAYS #13 money-gated ----------------------------
  {
    id: "ads_spend",
    label: "Ad budget",
    summary: "The customer's own ad budget. Releasing real spend ALWAYS pauses for the owner (#13, #243).",
    costClass: "customer_spend",
    providers: [],
    envKeys: [],
  },
  {
    id: "email_send_tier",
    label: "Email sending tier",
    summary: "Upgrading the customer's paid email-sending tier is the customer's money — owner-gated.",
    costClass: "customer_spend",
    providers: [],
    envKeys: [],
  },
];

const BY_ID: ReadonlyMap<string, CapabilityDescriptor> = new Map(
  CAPABILITY_DESCRIPTORS.map((d) => [d.id, d]),
);

/** Look up a capability descriptor by id (undefined for an unknown id — callers fail closed). */
export function getCapabilityDescriptor(id: string): CapabilityDescriptor | undefined {
  return BY_ID.get(id);
}

/** List the catalog, optionally filtered by cost class. */
export function listCapabilityDescriptors(
  opts: { costClass?: CapabilityCostClass } = {},
): CapabilityDescriptor[] {
  return CAPABILITY_DESCRIPTORS.filter((d) => !opts.costClass || d.costClass === opts.costClass);
}

/** True iff the capability is fulfilled by the customer's OWN money (so it is ALWAYS money-gated). */
export function isCustomerSpendCapability(id: string): boolean {
  return getCapabilityDescriptor(id)?.costClass === "customer_spend";
}

/**
 * The CENTRAL vault `service_key` a provider's credential is stored under (in the OWNER workspace, never
 * the customer's). One place, one key, billed into the plan — this is the "customer never sees a key"
 * invariant expressed as a key-derivation rule. `central:` namespaces it so it can never collide with a
 * customer-pasted #192 connection or a #68 subscription key.
 */
export function centralServiceKey(provider: string): string {
  return `central:${provider}`;
}
