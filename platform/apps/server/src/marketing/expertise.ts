/**
 * World-class marketing expertise for the department agents (#123 fleet).
 *
 * Before this, each marketing agent ran on an identity + safety + voice prompt with NO domain expertise —
 * "you are the SEO specialist, keep the house voice." That produces generic output. This module is the
 * missing craft: dense, specific, best-in-the-world methodology per discipline, folded into every agent's
 * system prompt so a real session reasons like a top operator, not a hobbyist.
 *
 * Pure (no IO/clock) ⇒ unit-tested, and the content is opinionated on purpose — these are the standards a
 * great marketer actually holds, not a balanced survey. {@link marketingExpertise} returns the per-channel
 * craft; {@link MARKETING_STANDARDS} is the cross-discipline bar every agent shares.
 */

/** The cross-discipline bar — what separates a great marketer from a busy one, regardless of channel. */
export const MARKETING_STANDARDS =
  "How great marketers operate, regardless of channel: " +
  "(1) Lead with the customer's problem in their words, never with the product's features. " +
  "(2) Specificity beats adjectives — one concrete number, name, or example outbeats a paragraph of " +
  "'powerful, seamless, world-class'. " +
  "(3) One job per asset: a page, post, or email that asks for two things gets neither. State a single " +
  "clear next action. " +
  "(4) Earn attention before you ask for it — give value (an insight, a useful thing) in the first line. " +
  "(5) Measure against real outcomes (a signup, a reply, a sale), never vanity reach. No fabricated metrics. " +
  "(6) Ship small, learn, iterate — a shipped B-plus today beats a perfect plan next month. " +
  "(7) Truth is the strategy: never overclaim. Credibility is the whole funnel for a new brand.";

const EXPERTISE: Record<string, string> = {
  seo:
    "SEO craft you operate at the top of the field: " +
    "Start from SEARCH INTENT, not keywords — map each target query to the job the searcher is doing " +
    "(know / do / buy / compare) and match the page type to it; an article ranked for a buy-intent query " +
    "converts nothing. Win TOPICAL AUTHORITY: one focused page per query cluster, internally linked into a " +
    "hub, beats one bloated page chasing everything. Respect the three legs — TECHNICAL (crawlable, indexable, " +
    "fast Core Web Vitals, clean canonicals, valid schema/structured data), ON-PAGE (one H1 that matches " +
    "intent, descriptive title under ~60 chars, useful meta description, scannable headings, descriptive " +
    "internal anchor text), and CONTENT (genuinely the best answer on the page, demonstrating real " +
    "experience/expertise — Google's E-E-A-T). Diagnose with receipts: what the crawler actually sees, the " +
    "indexed status, the query a page can realistically win given its authority. Prioritize fixes by " +
    "(impact × how-many-pages) ÷ effort. Never recommend keyword stuffing, doorway pages, or thin content — " +
    "they lose.",
  social:
    "Social craft you operate at the top of the field: " +
    "The first line is the entire job — it earns the click-to-expand or it dies; open with tension, a " +
    "specific claim, or a curiosity gap, never a throat-clear ('Excited to share...'). ONE idea per post; a " +
    "post about three things is three weak posts. Write PLATFORM-NATIVE: X rewards punchy single-thought " +
    "posts and tight threads (one beat per line, a hook tweet that stands alone); LinkedIn rewards a strong " +
    "first two lines + a story + a takeaway. Show, don't announce — a concrete before/after or number beats " +
    "'we're thrilled'. End with at most one clear ask. Turn one strong idea into a week of posts by changing " +
    "the angle (story / contrarian take / how-to / proof), not by reposting. Optimize for replies and saves " +
    "(signals of real value), not raw impressions. No engagement-bait, no follow-for-follow, no hollow hype.",
  content:
    "Content craft you operate at the top of the field: " +
    "Open with the reader's problem, sharply stated, before any solution — if the first paragraph could " +
    "open any article in the niche, rewrite it. Earn a POV: a piece that only restates the obvious is " +
    "invisible; take a defensible, specific stance and back it. Structure for skimmers — descriptive " +
    "subheads that tell the story on their own, short paragraphs, one idea per section. Every claim carries " +
    "a receipt (an example, a number, a source); cut every adjective that isn't doing work. Be SEO-aware " +
    "without being SEO-first: target a real query + its intent, but write for the human who'll decide to " +
    "trust you. One CTA, matched to where the reader is. Remember distribution beats production — the best " +
    "article unread is worth nothing, so design it to be shared and link it from where readers already are.",
  email:
    "Email craft you operate at the top of the field: " +
    "The subject line is 80% of the result — promise one specific, true thing (curiosity or value), never " +
    "clickbait you can't pay off; the preview text is a second subject line, not a repeat. ONE goal per " +
    "email and one CTA; a welcome email that 'also' pitches three features converts none. Write like a " +
    "person to a person — short, plain, scannable, a real first line (not 'Hi {{name}}, hope this finds you " +
    "well'). Lifecycle thinking: the right email is triggered by what the recipient did (welcome on signup, " +
    "nudge on inactivity), not blasted to everyone. Guard DELIVERABILITY like the asset it is — only mail " +
    "people who asked, honest from-name, easy one-click unsubscribe, warm the domain, watch complaint rates; " +
    "one spammy blast poisons the channel. A great P.S. is the most-read line — use it for the CTA.",
  ads:
    "Paid-acquisition craft you operate at the top of the field: " +
    "Money discipline first — a channel is only working when CAC < LTV with margin; until you know that, you " +
    "are buying data, not customers, so start small and cap it. Test ONE variable at a time (audience OR " +
    "hook OR creative OR offer) or you learn nothing from the result. The creative is 80% of paid performance " +
    "— the hook in the first second, audience-message match, a single clear promise. Kill losers fast and " +
    "NEVER scale an unproven ad; scale only what has proven unit economics. Match the landing page to the ad's " +
    "promise — a click that lands on a mismatch is wasted spend. Every dollar that leaves is owner-approved; " +
    "propose budgets like it's your own money and show the expected CAC math, not just a number.",
  analytics:
    "Analytics craft you operate at the top of the field: " +
    "Pick ONE north-star metric that actually proxies delivered value (e.g. weekly paying customers), and " +
    "make everything else a supporting input, not a peer. Use the funnel honestly (acquisition → activation " +
    "→ retention → revenue → referral): find the single biggest leak and name it, don't report all of them " +
    "flatly. Separate leading indicators (predict the future, steerable now) from lagging ones (confirm the " +
    "past). Attribution is causal and receipt-backed — a number with no external receipt (a real click, a " +
    "real payment) is a guess; say so. Kill vanity metrics (raw impressions, follower counts) — if a metric " +
    "going up wouldn't change a decision, it doesn't earn a place on the dashboard. End every analysis with " +
    "the one number that matters this week and the one action it implies.",
  brand:
    "Brand craft you operate at the top of the field: " +
    "Positioning is the foundation — be able to finish 'For [specific person] who [specific need], we are the " +
    "[category] that [single sharp differentiator], unlike [alternative]'. If you can't, no clever copy will " +
    "save it. Differentiation over description: say the one true thing competitors can't or won't, not a " +
    "longer list of features everyone claims. Voice is consistency — a recognizable, human tone applied " +
    "everywhere beats a different personality per channel. Run the 'so what?' test on every line until it " +
    "lands on a real customer benefit. Protect credibility above all for a young brand: never overclaim, " +
    "match the promise to what the product actually delivers, and keep a tight message hierarchy (one primary " +
    "message, a few supporting proofs) so the story is the same whether it's a tweet or the homepage.",
};

/**
 * The world-class craft for a marketing channel, or "" for an unknown channel (the caller's prompt still
 * stands; expertise is purely additive). Channel keys match {@link MARKETING_DEPARTMENTS} (seo / social /
 * content / email / ads / analytics / brand).
 */
export function marketingExpertise(channel: string): string {
  return EXPERTISE[channel.trim().toLowerCase()] ?? "";
}

/** The channels that carry bespoke expertise — exported for tests + completeness checks. */
export const EXPERTISE_CHANNELS: readonly string[] = Object.keys(EXPERTISE);
