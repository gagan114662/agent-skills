import type { SignupEntryConfig } from "../config/schema.js";

/**
 * Low-commitment signup entry (#300, ADR-0300) — the pure half.
 *
 * Today `/start`'s only path is "Sign in with Google", and that single consent grants Search Console +
 * Analytics up front (#260). For a prospect who doesn't use Google, won't grant data scopes just to look,
 * or simply wants to evaluate first, that broad-scope OAuth wall is the highest-friction possible first
 * step — it kills the aha. This module backs two front-door alternatives, both **default OFF**:
 *
 *  1. a read-only {@link buildSampleConsole sample workspace} a visitor can explore with NO account and NO
 *     Google data scope, seeing at least one real agent deliverable; and
 *  2. progressive Google scopes (see `auth/google-oauth` `resolveOnboardingScopes`) so even the Google path
 *     requests only identity at signup and defers GSC/Analytics to the moment SEO work is initiated.
 *
 * Honoring the premortem (#200):
 *  - §3 production-grounded / honest degrade: when a flag is OFF the front door behaves exactly as #260
 *    (Google-only, single full-scope consent) — nothing is faked.
 *  - §4 reversibility: the sample console is READ-ONLY — it creates no workspace, no session, no row, and
 *    triggers no real-world action, so there is nothing to undo (bounded blast radius by construction).
 *  - §6 injection defense: {@link buildSampleConsole} takes NO input — the demo content is a static
 *    constant, so a poisoned request can never steer what it renders.
 *
 * These are anonymous front-door features (no workspace exists at `/start` yet), so the deployment flag IS
 * the owner-first control — the owner turns it on for their own deployment first (see ADR-0300).
 */

// ---------------------------------------------------------------------------------------------------
// Policy (#58 layered config) — default OFF. Mirrors `auth/claude-connect` caps resolution.
// ---------------------------------------------------------------------------------------------------

export interface SignupEntryCaps {
  /** Offer the read-only sample workspace from `/start` — default OFF. */
  sampleWorkspace: boolean;
  /** Request identity-only Google scopes at signup, deferring GSC/Analytics to SEO — default OFF. */
  progressiveScopes: boolean;
}

export const SIGNUP_ENTRY_DEFAULTS: SignupEntryCaps = {
  sampleWorkspace: false,
  progressiveScopes: false,
};

export function resolveSignupEntryCaps(cfg: SignupEntryConfig | undefined): SignupEntryCaps {
  const d = SIGNUP_ENTRY_DEFAULTS;
  return {
    sampleWorkspace: cfg?.sampleWorkspace ?? d.sampleWorkspace,
    progressiveScopes: cfg?.progressiveScopes ?? d.progressiveScopes,
  };
}

/** Is the read-only sample workspace offered from the front door? Pure + fail-closed (off ⇒ never). */
export function isSampleWorkspaceOffered(caps: SignupEntryCaps): boolean {
  return caps.sampleWorkspace;
}

/** Are progressive Google scopes enabled (identity-only at signup)? Pure + fail-closed. */
export function isProgressiveScopesEnabled(caps: SignupEntryCaps): boolean {
  return caps.progressiveScopes;
}

// ---------------------------------------------------------------------------------------------------
// The read-only sample workspace payload.
// ---------------------------------------------------------------------------------------------------

/** One deliverable card shown in the sample console — a representative real agent output. */
export interface SampleDeliverable {
  /** Stable, unique id so the UI can key the card. */
  id: string;
  /** The agent persona that produced it (display only). */
  agent: string;
  /** The department it belongs to (display only). */
  department: string;
  /** A human title — the work itself. */
  title: string;
  /** The first line of what the agent produced (the card preview). */
  preview: string;
  /** The full deliverable body (markdown), shown when the card is opened. */
  body: string;
}

/** The read-only sample console a prospect explores before granting any scope. */
export interface SampleConsole {
  /** Always true — marks this payload as a demo, never a real tenant. */
  readOnly: true;
  /** A short label for the demo workspace (display only). */
  workspaceLabel: string;
  /** At least one real agent deliverable (the aha: see real output before committing). */
  deliverables: SampleDeliverable[];
}

/**
 * A representative Scout SEO deliverable — the kind the fleet produces from a real site audit. It is a
 * static constant (not generated per-request and not live), so the sample console is deterministic,
 * side-effect-free, and injection-safe by construction (#200 §6). The example domain is deliberately
 * generic so the demo reads as "here's what your agent would hand you", not a specific customer's data.
 */
const SAMPLE_SEO_DELIVERABLE_BODY = `# SEO audit — example.com

**Summary:** Strong foundation, three high-impact fixes. Estimated +18% organic clicks within 60 days.

## What's working
- Fast LCP (1.4s on mobile) and a valid sitemap with 42 indexed URLs.
- Clean title/description tags on the top 10 landing pages.

## Three fixes, ranked by impact
1. **Add FAQ schema to /pricing** — competitors win the "is it free" snippet; structured data reclaims it.
2. **Consolidate two thin blog posts** into one 1,200-word guide targeting "automated SEO audit".
3. **Fix 7 broken internal links** (audit attached) leaking crawl budget from the docs section.

## Next step
Approve and Scout will draft the FAQ schema + the consolidated guide for your review — no publishing
happens without your sign-off.`;

const SAMPLE_DELIVERABLES: SampleDeliverable[] = [
  {
    id: "sample-scout-seo-audit",
    agent: "Scout",
    department: "SEO",
    title: "SEO audit — example.com",
    preview: "Strong foundation, three high-impact fixes. Estimated +18% organic clicks within 60 days.",
    body: SAMPLE_SEO_DELIVERABLE_BODY,
  },
];

/**
 * Build the read-only sample console. Pure + total + input-free: it returns the same static demo content
 * every time, so a prospect can see a real deliverable with no account and no Google data scope (#300 AC).
 */
export function buildSampleConsole(): SampleConsole {
  return {
    readOnly: true,
    workspaceLabel: "Sample workspace",
    // Defensive copy so a caller mutating the result can never corrupt the shared constant.
    deliverables: SAMPLE_DELIVERABLES.map((d) => ({ ...d })),
  };
}
