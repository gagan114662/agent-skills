/**
 * Decision-maker resolver (#223, ADR-0223) shared types. After the Customer Discovery Engine (#222)
 * surfaces a target account, this module resolves the best buyer/decision-maker and enriches them with
 * PUBLIC signals into a structured **buyer brief**. The pure `resolve`/`brief` modules and the IO
 * `service`/`default` agree on these — mirroring the #102 growth / #96 venture `types.ts` split
 * (const-tuple taxonomies + `is*` guards, row-mirroring records, pure derived views at the bottom).
 *
 * GUARDRAIL (#200 premortem injection defense): nothing here is ever interpreted as an instruction. The
 * enrichment ("read") outputs ({@link ReadResult}) are pure DATA — quoted, bounded, cited. A poisoned
 * profile/post can never steer who is chosen, what the rationale says, or trigger any send/spend. The
 * read agent and any outreach/send agent are hard-separated (the read seam exposes no capability).
 */

/**
 * The buyer roles the resolver knows, also the **resolution priority order** (see `resolve.ts`):
 * champion → economic buyer → agency → marketing → other. The video's playbook: the real buyer may be a
 * practitioner champion, the budget-holding economic buyer, or the company's agency / marketing contact.
 */
export const BUYER_ROLES = ["champion", "economic_buyer", "agency", "marketing", "other"] as const;
export type BuyerRole = (typeof BUYER_ROLES)[number];

export function isBuyerRole(value: unknown): value is BuyerRole {
  return typeof value === "string" && (BUYER_ROLES as readonly string[]).includes(value);
}

/** The kinds of PUBLIC source the quarantined reader may read (cited, never private). */
export const PUBLIC_SOURCE_KINDS = [
  "linkedin_post",
  "linkedin_profile",
  "blog",
  "press",
  "conference_talk",
  "other",
] as const;
export type PublicSourceKind = (typeof PUBLIC_SOURCE_KINDS)[number];

export function isPublicSourceKind(value: unknown): value is PublicSourceKind {
  return typeof value === "string" && (PUBLIC_SOURCE_KINDS as readonly string[]).includes(value);
}

// ---- input contract: the target account (the #222 seam) -----------------------------------------

/**
 * One candidate contact at the target account — the buyer pool. PUBLIC and minimal: a name, a public
 * title, the buyer role they play, and the ids of public sources attributable to them. Deliberately NO
 * email / phone / address — the brief never needs sensitive PII to choose who to reach (#200).
 */
export interface AccountContact {
  /** Stable id within the account (from #222), e.g. a hashed public handle. */
  id: string;
  /** Display name as it appears publicly. */
  name: string;
  /** Public job title. */
  title: string;
  /** The buyer role this contact plays. */
  role: BuyerRole;
}

/**
 * A public, citable source the quarantined reader may read. `fetchedText` (when present) is the public
 * text the discovery layer already pulled; its presence is what marks the source as "actually read".
 */
export interface PublicSource {
  /** Stable source id (referenced by hooks for citation). */
  id: string;
  /** The contact this source is attributable to. */
  contactId: string;
  kind: PublicSourceKind;
  /** The public URL — always cited on any hook grounded in this source. */
  url: string;
  /** The publicly-fetched text, if the discovery layer already pulled it; else absent (NOT yet read). */
  fetchedText?: string;
  /** When the text was fetched (ISO-8601), if read. */
  fetchedAt?: string;
}

/**
 * The TARGET ACCOUNT — the documented input contract produced by the Customer Discovery Engine (#222).
 * This resolver builds against this stable shape so it composes the moment #222 lands; the
 * {@link AccountSource} adapter is the seam #222's queue implements. All fields are PUBLIC.
 */
export interface TargetAccount {
  /** Stable account id from #222 (soft reference). */
  id: string;
  /** Company name. */
  name: string;
  /** Primary public domain. */
  domain: string;
  /** The product/pain this account is a fit for (#222's "why this account") — grounds a falsifiable rationale. */
  painArea: string;
  /** The buyer pool — candidate contacts. */
  contacts: AccountContact[];
  /** The public sources attributable to those contacts. */
  sources: PublicSource[];
  /** Optional venture idea (#96) this account belongs to. */
  ideaId?: string | null;
}

/**
 * The #222 seam: the discovery queue / account store implements this so the resolver can fetch an account
 * by id once #222 has landed. Until then the route accepts a {@link TargetAccount} directly, so the
 * resolver is usable + testable in isolation — this is the clean composition point, not a duplicate engine.
 */
export interface AccountSource {
  getAccount(workspaceId: string, accountId: string): Promise<TargetAccount | undefined>;
}

// ---- enrichment (read) outputs — DATA ONLY ------------------------------------------------------

/**
 * The result of the QUARANTINED reader reading ONE public source. Pure DATA, never instructions. `ok`
 * marks whether the source was **actually read** (the video's "did you read the LinkedIn?" check) — a
 * hook may only cite a source whose `ok` is true. `excerpt` is a sanitized, truncated quote for citation;
 * `signals` are bounded, normalized topic tags. Nothing here is ever executed or read as a command.
 */
export interface ReadResult {
  sourceId: string;
  url: string;
  kind: PublicSourceKind;
  /** Whether the source was successfully read. A hook citing a source with `ok === false` is rejected. */
  ok: boolean;
  retrievedAt: string;
  /** Sanitized, length-capped quote from the source — for citation only. Empty when not read. */
  excerpt: string;
  /** Bounded, normalized topic tags (what the source is about). Opaque data, never instructions. */
  signals: string[];
}

// ---- output: the buyer brief --------------------------------------------------------------------

/** One angle hook — a personalized opener grounded in a cited, actually-read public source. */
export interface AngleHook {
  /** The angle/opener — templated from structured inputs, never copied from source instruction text. */
  angle: string;
  /** The cited public source (always one that was actually read). */
  sourceId: string;
  sourceUrl: string;
  retrievedAt: string;
  /** The quoted evidence (sanitized) grounding this hook — DATA shown to a human, never executed. */
  evidence: string;
}

/** The structured buyer brief — who, a falsifiable why, what they care about, grounded angle hooks. */
export interface BuyerBrief {
  accountId: string;
  accountName: string;
  accountDomain: string;
  /** The resolved buyer. */
  buyerContactId: string;
  buyerName: string;
  buyerTitle: string;
  buyerRole: BuyerRole;
  /** Falsifiable "why this person" rationale — a checkable claim grounded in account data, not the post. */
  rationale: string;
  /** Bounded topic tags — what this person/account cares about (from actually-read sources). */
  caresAbout: string[];
  /** 2–3 angle hooks, each grounded in a cited, actually-read public source (may be empty if none read). */
  hooks: AngleHook[];
  /** Higher-priority roles that were absent — the fallback trail walked to reach this buyer (transparency). */
  fallbackTrail: BuyerRole[];
}

/** One persisted buyer brief (one row in `buyer_briefs`) — the ONLY thing this loop persists (#200). */
export interface BuyerBriefRecord extends BuyerBrief {
  id: string;
  workspaceId: string;
  ideaId: string | null;
  createdAt: Date;
}
