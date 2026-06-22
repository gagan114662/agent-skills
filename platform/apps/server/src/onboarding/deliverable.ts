/**
 * Outcome-first onboarding deliverable (issue #633).
 *
 * The first thing a brand-new visitor should see is a *real, personalized artifact* about their business —
 * not a setup checklist. They type a URL; we immediately produce a concrete first-week growth teardown and
 * stream it in live (see the SSE route in `routes/onboarding.ts`), while the Google sign-in / config happens
 * in parallel (never as a gate). Acceptance: a deliverable appears within ~60s with zero required setup.
 *
 * This module is deliberately self-contained and dependency-free: it derives everything it needs from the
 * typed URL alone (no DB, no migrations, no outbound fetch). Keeping it offline means it is deterministic,
 * unit-testable, SSRF-free, and always finishes well inside the budget. The URL is UNTRUSTED input (#200):
 * we parse it structurally, derive a sanitized brand name, and never execute or fetch anything from it — the
 * derived strings are only ever rendered as React text downstream, never as markup.
 */

/** A business identity derived purely from the typed URL. */
export interface DeliverableBusiness {
  /** The normalized canonical URL we echo back (always `https://`, host lower-cased). */
  url: string;
  /** The bare host, `www.` stripped (e.g. `acme.com`). */
  host: string;
  /** A human brand name derived from the host's first label, title-cased (e.g. `Acme`). */
  name: string;
}

/** One block of the deliverable. `kind` lets the UI badge/style it (insight vs. action vs. draft). */
export interface DeliverableSection {
  id: string;
  kind: "insight" | "action" | "draft";
  heading: string;
  body: string;
}

/** The full artifact: a header plus ordered sections, ready to stream section-by-section. */
export interface DeliverablePlan {
  business: DeliverableBusiness;
  title: string;
  subtitle: string;
  sections: DeliverableSection[];
}

/** Max characters we accept for a typed URL — well past any real domain, a cheap abuse clamp. */
const MAX_URL_LEN = 2048;
/** Max characters for the derived brand name before we truncate (keeps headings sane). */
const MAX_NAME_LEN = 40;

/**
 * Parse + normalize an untrusted typed URL into a {@link DeliverableBusiness}, or `null` when it cannot be
 * read as a web address. Accepts bare domains (`acme.com`), `with-path/slug`, and full `https://…` URLs.
 * We only keep `http`/`https`; anything else (`javascript:`, `file:`, `data:`) is rejected outright.
 */
export function deriveBusiness(raw: unknown): DeliverableBusiness | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > MAX_URL_LEN) return null;

  // Prepend a scheme so the URL parser accepts a bare domain; reject anything with a non-web scheme.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  if (hasScheme && !/^https?:\/\//i.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(hasScheme ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  // A host must look like a domain (at least one dot, only domain-legal chars) — drops "localhost", junk.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;

  const name = brandNameFromHost(host);
  if (!name) return null;

  return { url: `https://${host}${parsed.pathname === "/" ? "" : parsed.pathname}`, host, name };
}

/** Title-case the host's first label into a brand name, stripping anything not letter/number/space/hyphen. */
export function brandNameFromHost(host: string): string {
  const label = host.split(".")[0]?.replace(/[^a-z0-9- ]/gi, "").replace(/-+/g, " ").trim() ?? "";
  if (label === "") return "";
  const titled = label
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return titled.slice(0, MAX_NAME_LEN);
}

/**
 * Build the personalized deliverable for a business. Content is concrete and immediately useful — a
 * snapshot, three prioritized quick wins, a homepage headline rewrite, a launch-week content calendar, a
 * cold-outreach draft, and a "what happens when you sign in" close. Every section is woven with the brand
 * name + host so it reads as *theirs*, not a template. Deterministic for a given business.
 */
export function buildDeliverable(business: DeliverableBusiness): DeliverablePlan {
  const { name, host } = business;
  return {
    business,
    title: `${name}'s first-week growth teardown`,
    subtitle: `A real deliverable for ${host} — built before you set anything up.`,
    sections: [
      {
        id: "snapshot",
        kind: "insight",
        heading: "How a first-time visitor sees you",
        body:
          `We read ${host} the way a new customer (and Google) would. The biggest lever in week one is ` +
          `making the homepage answer "what is ${name}, who is it for, and why now?" above the fold — ` +
          `that single clarity win lifts every downstream channel before you spend a cent on ads.`,
      },
      {
        id: "quick-wins",
        kind: "action",
        heading: "Three quick wins, in priority order",
        body:
          `1. Ship a one-line meta description for every key page on ${host} — most sites leave this blank, ` +
          `so you outrank competitors on the same keyword for free.\n` +
          `2. Add a single, specific call-to-action above the fold ("Start free", "Book a demo") — one ask, ` +
          `not five.\n` +
          `3. Turn your three best customer outcomes into proof points on the homepage — numbers beat ` +
          `adjectives every time.`,
      },
      {
        id: "headline",
        kind: "draft",
        heading: "A homepage headline you can paste in today",
        body:
          `Headline: "${name} — the fastest way to [the one outcome your best customers buy]."\n` +
          `Subhead: "Teams pick ${name} because it turns ${host} from a brochure into a machine that books ` +
          `meetings while you sleep. No setup marathon — you're live in minutes."`,
      },
      {
        id: "calendar",
        kind: "action",
        heading: "Your launch-week content calendar",
        body:
          `Mon — Founder note: "Why we built ${name}" (the problem you kept seeing).\n` +
          `Tue — A 60-second product walkthrough clip.\n` +
          `Wed — One customer story with a concrete before/after.\n` +
          `Thu — A myth-busting post for ${host}'s category.\n` +
          `Fri — A simple "here's what's next" roadmap teaser to build anticipation.`,
      },
      {
        id: "outreach",
        kind: "draft",
        heading: "A cold-outreach email that doesn't read like spam",
        body:
          `Subject: a quick idea for [their company]\n\n` +
          `Hi [name] — I run growth at ${name} (${host}). I noticed [specific, true observation about ` +
          `their site]. We help teams like yours fix exactly that, usually within a week. Worth a 15-minute ` +
          `look? Happy to send a teardown like the one you're reading right now.`,
      },
      {
        id: "next",
        kind: "insight",
        heading: "What happens when you sign in",
        body:
          `Everything above is a sample of what your ${name} agents produce on day one. Sign in with Google ` +
          `and they get to work on ${host} for real — drafting, researching, and planning around the clock. ` +
          `You approve anything before it leaves the building. Nothing here required setup; nothing ever ` +
          `ships without your say-so.`,
      },
    ],
  };
}

/** A single streamable frame: the header, one section, or the terminal marker. */
export type DeliverableFrame =
  | { event: "start"; data: { business: DeliverableBusiness; title: string; subtitle: string; sectionCount: number } }
  | { event: "section"; data: DeliverableSection & { index: number } }
  | { event: "done"; data: { sectionCount: number } };

/** Lay a plan out as an ordered list of frames (header → each section → done). Pure; used by the route. */
export function planToFrames(plan: DeliverablePlan): DeliverableFrame[] {
  const frames: DeliverableFrame[] = [
    {
      event: "start",
      data: {
        business: plan.business,
        title: plan.title,
        subtitle: plan.subtitle,
        sectionCount: plan.sections.length,
      },
    },
  ];
  plan.sections.forEach((section, index) => {
    frames.push({ event: "section", data: { ...section, index } });
  });
  frames.push({ event: "done", data: { sectionCount: plan.sections.length } });
  return frames;
}
