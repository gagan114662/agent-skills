import type {
  Icp,
  ReachChannel,
  ReachMessage,
  ReachSignalKind,
  ReachVariant,
  ScoredProspect,
} from "./types.js";

/**
 * Opener personalisation (#280 step 4). Pure. Builds a 1:1 opener around what the prospect JUST DID (the
 * freshest buying signal), in the requested value-prop {@link ReachVariant}.
 *
 * INJECTION-QUARANTINE (the load-bearing rule): a signal's `summary` is untrusted DATA pulled from a
 * third party. Before it touches an opener it is run through {@link sanitizeText} (control chars stripped,
 * length capped, collapsed) so it can only ever be an inert string in the body. The SEND TARGET
 * (`toAddress`) and the human label come ONLY from the prospect's structured contact fields — never from
 * signal text — so a poisoned signal cannot redirect a message or trigger an action.
 */

/** Strip control chars, collapse whitespace, trim, cap length. Turns untrusted text into an inert string. */
export function sanitizeText(text: string, max = 160): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 32 || code === 127 ? " " : ch;
  }
  out = out.replace(/\s+/g, " ").trim();
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
}

/** First name only, sanitised — what an opener greets with ("Hi Jane,"). Falls back to "there". */
export function firstName(fullName: string): string {
  const first = sanitizeText(fullName, 40).split(" ")[0] ?? "";
  return first || "there";
}

/** A fixed, human phrasing per signal kind — what we OBSERVED, in our words (never the raw provider text). */
const SIGNAL_PHRASE: Record<ReachSignalKind, string> = {
  funding_round: "saw the funding news",
  hiring_surge: "noticed you're hiring fast",
  tech_adoption: "saw you're rolling out new tooling",
  pricing_page_visit: "saw you were looking into options like ours",
  content_engagement: "noticed you've been digging into this space",
  job_change: "saw you've stepped into a new role",
  competitor_switch: "heard you're re-evaluating your current setup",
};

/** The opening line by value-prop angle. `{problem}` is the ICP's lead keyword. */
function angleLine(variant: ReachVariant, problem: string, company: string): string {
  switch (variant) {
    case "pain":
      return `Most teams your size lose more time to ${problem} than they realise.`;
    case "outcome":
      return `Teams like ${company} usually get ${problem} off their plate within a couple of weeks of trying us.`;
    case "social_proof":
      return `A few companies a lot like ${company} switched to us for ${problem} recently.`;
  }
}

function prospectContext(title: string, company: string): string {
  const role = sanitizeText(title, 80);
  if (role && company !== "your team") return `As ${role} at ${company}, `;
  if (role) return `In your ${role} role, `;
  if (company !== "your team") return `At ${company}, `;
  return "";
}

export interface PersonalizeInput {
  scored: ScoredProspect;
  icp: Icp;
  channel: ReachChannel;
  variant: ReachVariant;
  /** The sending brand (signature). */
  brandName: string;
}

/**
 * Compose the 1:1 message. The send target is the structured contact field for the channel; the human
 * label is "<name> · <company>". The signal hook is a sanitised snippet of the provider summary (so it
 * reads "you just X"), prefixed by our own fixed phrasing — never the raw text alone.
 */
export function personalizeOpener(input: PersonalizeInput): ReachMessage {
  const { scored, icp, channel, variant, brandName } = input;
  const p = scored.prospect;
  const name = firstName(p.fullName);
  const company = sanitizeText(p.company, 60) || "your team";
  const context = prospectContext(p.title, company);
  const problem = icp.keywords[0] ?? "growth";

  // The "what you just did" hook — our phrasing + an optional sanitised snippet of the provider summary.
  let hook = "";
  if (scored.freshSignal) {
    const phrase = SIGNAL_PHRASE[scored.freshSignal.kind];
    const snippet = sanitizeText(scored.freshSignal.summary, 110);
    hook = snippet ? `${context}I ${phrase} — ${snippet}. ` : `${context}I ${phrase}. `;
  } else {
    hook = context;
  }

  const subject =
    channel === "email"
      ? scored.freshSignal
        ? `${company}: a quick thought after the news`
        : `A quick idea for ${company}`
      : "";

  const body = [
    `Hi ${name},`,
    "",
    `${hook}${angleLine(variant, problem, company)}`,
    "",
    `Worth a 15-minute look? Happy to send a couple of ideas specific to ${company} either way.`,
    "",
    `— ${sanitizeText(brandName, 60) || "The team"}`,
  ].join("\n");

  const toAddress = (channel === "email" ? p.email : p.linkedinUrl) ?? "";

  return {
    contactKey: scored.contactKey,
    channel,
    toAddress,
    recipientLabel: `${sanitizeText(p.fullName, 60) || "Prospect"} · ${company}`,
    subject,
    body,
    variant,
    signalKind: scored.freshSignal?.kind ?? null,
  };
}

/** Recover the structured send target from a stored dedupe key ("email:foo@bar" → "foo@bar"). */
export function addressFromContactKey(contactKey: string): { channel: ReachChannel; toAddress: string } | null {
  if (contactKey.startsWith("email:")) return { channel: "email", toAddress: contactKey.slice("email:".length) };
  if (contactKey.startsWith("linkedin:")) return { channel: "linkedin", toAddress: contactKey.slice("linkedin:".length) };
  return null; // an "id:name|company" key has no reachable address — can't follow up
}

export interface FollowUpInput {
  contactKey: string;
  /** The stored "Name · Company" label (the only prospect text a follow-up has). */
  recipientLabel: string;
  channel: ReachChannel;
  variant: ReachVariant;
  /** Which touch this is (2nd = first follow-up, 3rd = nudge) — flavours the copy. */
  step: number;
  brandName: string;
}

/**
 * Compose a later-cadence touch (step ≥ 1). A follow-up has only the structured label + key to work from
 * (we don't re-fetch the prospect), so it's a short, on-angle nudge — never a re-blast of the opener. The
 * send target is recovered from the structured contact key; signal text never re-enters here.
 */
export function composeFollowUp(input: FollowUpInput): ReachMessage | null {
  const target = addressFromContactKey(input.contactKey);
  if (!target) return null;
  const label = sanitizeText(input.recipientLabel, 120);
  const name = sanitizeText(label.split("·")[0] ?? "", 40).trim() || "there";
  const first = name.split(" ")[0] || "there";
  const subject =
    target.channel === "email" ? (input.step >= 2 ? "One last thought" : "Following up") : "";
  const body = [
    `Hi ${first},`,
    "",
    input.step >= 2
      ? "Last note from me — if the timing's off, no worries at all. If it's worth a quick look, I'm one reply away."
      : "Circling back in case this slipped past — happy to share a couple of concrete ideas if it's useful.",
    "",
    `— ${sanitizeText(input.brandName, 60) || "The team"}`,
  ].join("\n");
  return {
    contactKey: input.contactKey,
    channel: input.channel,
    toAddress: target.toAddress,
    recipientLabel: label || "Prospect",
    subject,
    body,
    variant: input.variant,
    signalKind: null,
  };
}
