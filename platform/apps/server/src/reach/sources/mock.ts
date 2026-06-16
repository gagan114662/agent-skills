import type {
  ProspectSearchInput,
  ProspectSearchResult,
  ProspectSource,
} from "../prospect-source.js";
import { contactKey } from "../score.js";
import type { RawProspect, ReachSignalKind } from "../types.js";

/**
 * The free, deterministic prospect source (#280). It fabricates plausible on-ICP prospects with live
 * buying signals so the loop runs end-to-end with NO paid data and NO network — the autonomous default
 * (free ⇒ no money gate). Deterministic given (icp, limit, now): the same inputs always yield the same
 * prospects, so tests and a dry-run cron are reproducible. It is NOT a data provider — it never claims a
 * prospect is real; it exists so the pipeline is exercisable before an owner connects Clay/Lusha/Vibe.
 */

const FIRST_NAMES = ["Jordan", "Riley", "Casey", "Morgan", "Avery", "Quinn", "Skyler", "Reese"];
const LAST_NAMES = ["Lee", "Patel", "Nguyen", "Garcia", "Kim", "Owens", "Diaz", "Ford"];
const COMPANIES = ["Northwind", "Brightline", "Cedar", "Halcyon", "Momentum", "Tidewater", "Vantage", "Orbit"];

const SIGNAL_SUMMARY: Record<ReachSignalKind, string> = {
  funding_round: "Announced a new funding round this week",
  hiring_surge: "Posted several growth-team roles recently",
  tech_adoption: "Started rolling out new go-to-market tooling",
  pricing_page_visit: "Visited a pricing page for a tool like ours",
  content_engagement: "Engaged with content in this space recently",
  job_change: "Recently stepped into a new growth leadership role",
  competitor_switch: "Signalled they're re-evaluating their current vendor",
};

const DAY_MS = 24 * 60 * 60 * 1000;

export interface MockProspectSourceDeps {
  /** Injected clock so signal timestamps (and thus determinism) are controllable in tests. */
  now?: () => number;
}

export function createMockProspectSource(deps: MockProspectSourceDeps = {}): ProspectSource {
  const now = deps.now ?? (() => Date.now());
  return {
    kind: "mock",
    paid: false,
    estimateCostCents: () => 0,
    async search(input: ProspectSearchInput): Promise<ProspectSearchResult> {
      const nowMs = now();
      const role = input.icp.roles[0] ?? "head of growth";
      const industry = input.icp.industries[0] ?? null;
      const size = input.icp.companySizes[0] ?? null;
      const signalKinds = input.icp.signalKinds.length > 0 ? input.icp.signalKinds : ["content_engagement" as const];

      const prospects: RawProspect[] = [];
      // Over-generate then filter excludeKeys, so a run after dedupe still returns up-to-`limit` net-new.
      for (let i = 0; prospects.length < input.limit && i < input.limit * 3; i++) {
        const first = FIRST_NAMES[i % FIRST_NAMES.length]!;
        const last = LAST_NAMES[(i * 3) % LAST_NAMES.length]!;
        const company = COMPANIES[(i * 5) % COMPANIES.length]!;
        const slug = `${company.toLowerCase()}${i}`;
        const signalKind = signalKinds[i % signalKinds.length]!;
        const prospect: RawProspect = {
          fullName: `${first} ${last}`,
          title: role,
          company: `${company} ${i}`,
          companyDomain: `${slug}.example.test`,
          email: `${first.toLowerCase()}.${last.toLowerCase()}@${slug}.example.test`,
          linkedinUrl: `https://www.linkedin.com/in/${first.toLowerCase()}-${last.toLowerCase()}-${i}`,
          industry,
          companySize: size,
          signals: [
            {
              kind: signalKind,
              summary: SIGNAL_SUMMARY[signalKind],
              observedAtMs: nowMs - (i % 5) * DAY_MS,
            },
          ],
          sourceKind: "mock",
        };
        if (input.excludeKeys.has(contactKey(prospect))) continue;
        prospects.push(prospect);
      }
      return { prospects, provider: "mock", creditsCents: 0 };
    },
  };
}
