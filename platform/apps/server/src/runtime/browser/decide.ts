/**
 * The pure agent-browser step gate (#174, ADR-0174). Given a requested tool, the resolved per-session
 * caps, and the session's usage-so-far, decide whether the step may run — and, crucially, whether a
 * side-effectful step needs a #13 human approval first. Total and pure (no IO, no clock): the session
 * supplies `usage.elapsedMs`, so the same inputs always produce the same decision and the whole gate
 * is unit-tested without a browser. This is the single chokepoint the {@link BrowserSession} consults
 * before EVERY tool call, so a cap, a denylisted domain, or a missing approval can never be bypassed.
 *
 * Decision order (first match wins — most-restrictive first):
 *   1. `disabled`   — the runtime is off for this workspace (defence-in-depth; the manager also refuses).
 *   2. `forbidden`  — a non-overridable hard rule: never enter credentials, never solve a CAPTCHA. Not
 *                     even an approval unlocks these (ADR-0174 §2).
 *   3. `deny`       — a denylisted domain (reads AND writes), or a per-session cap exhausted.
 *   4. `deny`       — an enabled allowlist that the navigation target is not on.
 *   5. `needs_approval` — a side-effectful tool with no prior #13 approval (the safety gate).
 *   6. `allow`      — a read-only step within caps, or an approved side-effectful step.
 */
import { domainOf, matchesAllowlist } from "../egress-allowlist.js";
import type { BrowserCaps } from "./caps.js";
import { consumesPage, isSideEffectful, type BrowserToolName } from "./tools.js";

/** What the session has consumed so far — the running counters the caps are compared against. */
export interface BrowserUsage {
  /** Page navigations performed so far this session. */
  pages: number;
  /** Bytes transferred so far this session. */
  bytes: number;
  /** Wall-clock since the session opened, in milliseconds (supplied by the session — keeps this pure). */
  elapsedMs: number;
}

export interface BrowserStepInput {
  tool: BrowserToolName;
  /** The navigation URL (for `navigate`) or the current page URL (for other tools, for a denylist re-check). */
  target?: string;
  caps: BrowserCaps;
  usage: BrowserUsage;
  /** True iff a human has already approved this side-effectful step through #13 (the session passes it). */
  approved?: boolean;
  /** True iff the step would enter credentials (a password field) — a non-overridable hard refusal. */
  credentialEntry?: boolean;
  /** True iff the step would solve a CAPTCHA — a non-overridable hard refusal. */
  captcha?: boolean;
}

export type BrowserDecisionKind = "allow" | "deny" | "needs_approval" | "forbidden" | "disabled";

export interface BrowserStepDecision {
  decision: BrowserDecisionKind;
  reason: string;
}

export function decideBrowserStep(input: BrowserStepInput): BrowserStepDecision {
  const { tool, caps, usage } = input;

  // 1. The runtime is off for this workspace.
  if (!caps.enabled) {
    return { decision: "disabled", reason: "agent browser runtime is disabled for this workspace" };
  }

  // 2. Non-overridable hard rules — never, even with an approval.
  if (input.credentialEntry) {
    return { decision: "forbidden", reason: "the agent browser never enters credentials" };
  }
  if (input.captcha) {
    return { decision: "forbidden", reason: "the agent browser never solves CAPTCHAs" };
  }

  // 3a. Denylisted domain — blocked for reads AND writes (checked first, ahead of the allowlist).
  const domain = input.target ? domainOf(input.target) : null;
  if (domain && caps.denylist.length > 0 && matchesAllowlist(domain, caps.denylist)) {
    return { decision: "deny", reason: `domain ${domain} is on the browser denylist` };
  }

  // 3b. Per-session caps (0 = unlimited). Wall-clock + bandwidth apply to every tool; the page cap
  //     only bites a tool that loads a page.
  if (caps.maxWallClockSeconds > 0 && usage.elapsedMs >= caps.maxWallClockSeconds * 1000) {
    return { decision: "deny", reason: `session wall-clock cap reached (${caps.maxWallClockSeconds}s)` };
  }
  if (caps.maxBandwidthBytes > 0 && usage.bytes >= caps.maxBandwidthBytes) {
    return { decision: "deny", reason: `session bandwidth cap reached (${caps.maxBandwidthBytes} bytes)` };
  }
  if (consumesPage(tool) && caps.maxPages > 0 && usage.pages >= caps.maxPages) {
    return { decision: "deny", reason: `session page cap reached (${caps.maxPages} pages)` };
  }

  // 4. An enabled allowlist restricts where the browser may navigate. `about:blank` is the initial,
  //    contentless page (the default URL before any navigation) — it is exempt, NOT an "unparseable
  //    target", so read-only tools (read_page/screenshot) on a fresh session aren't spuriously denied.
  if (caps.allowlist.length > 0 && input.target && input.target !== "about:blank") {
    if (!domain) {
      return { decision: "deny", reason: "unparseable navigation target" };
    }
    if (!matchesAllowlist(domain, caps.allowlist)) {
      return { decision: "deny", reason: `domain ${domain} is not on the browser allowlist` };
    }
  }

  // 5. A side-effectful tool needs a #13 approval unless one has already been granted.
  if (isSideEffectful(tool) && !input.approved) {
    return { decision: "needs_approval", reason: `${tool} mutates remote state — requires approval` };
  }

  // 6. A read-only step within caps, or an approved side-effectful step.
  return { decision: "allow", reason: "within caps and policy" };
}
