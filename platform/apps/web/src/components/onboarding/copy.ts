/**
 * Every word of the #784 first-run onboarding, in the dialed-CHEEKY Innocent Drinks voice — full playful,
 * lowercase, a few jokes, a bit of attitude, but always legible and kind, never mean. Personality lives in
 * the small places: empty states, the agent narration, the connect prompts, the money gate, the celebration.
 *
 * This surface is intentionally self-contained (like the #610 DemoSandbox) and is NOT one of the brand-chrome
 * components scanned by brand.test — so its copy lives here rather than in brand.ts, keeping the new
 * experience-system voice in one editable place while we iterate against screenshots.
 */

/** Time-of-day greeting word. Pure so the greeting is deterministic in tests (pass the hour in). */
export function greetingWord(hour: number): "morning" | "afternoon" | "evening" {
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

/**
 * The warm door headline. The homepage has to work like Tomo: plain promise first, personality in the edges.
 */
export function greeting(hour: number, name?: string | null): string {
  void hour;
  void name;
  return "Make marketing pop.";
}

export const ONBOARD_COPY = {
  /** Persistent cowork-room chrome — the reload.chat × Claude cowork signal, without pretending work happened. */
  room: {
    eyebrow: "live cowork room",
    title: "your marketing team, already at the table",
    sub: "give them a target and they read, draft, queue, ask, and leave receipts. very professional. suspiciously tidy.",
    agents: [
      { who: "scout", job: "finds customers and awkward truths" },
      { who: "quill", job: "turns the truth into publishable words" },
      { who: "echo", job: "gets it seen without being annoying" },
      { who: "bid", job: "spends only when you say so" },
    ] as const,
    lanesTitle: "on the desk",
    lanes: {
      door: [
        "site read waiting for a target",
        "customer angle warming up",
        "send/spend policy locked",
      ],
      reading: [
        "scout reading the actual site",
        "quill listening for the sharp bit",
        "receipts being kept",
      ],
      connect: [
        "gmail, social, and site access stay honest",
        "no fake connected badges",
        "useful work appears only after real access",
      ],
      deliverable: [
        "one shippable asset in review",
        "approval before publish",
        "spend and sends still gated",
      ],
      shipped: ["receipt saved", "fleet awake", "next useful move queued"],
    } as const,
    receiptTitle: "receipts",
    receipts: {
      waiting: "nothing shipped yet. lovely restraint.",
      reading: "site read in progress",
      connected: "real access produced a visible payoff",
      deliverable: "draft ready for your yes",
      shipped: "approved by human, then shipped",
    },
  },

  /** SURFACE 1 · the door — one input, nothing else on the near-black canvas. */
  door: {
    /** The single field. */
    inputLabel: "what are we marketing today?",
    placeholder: "a product, or your website",
    /** Primary action. */
    submit: "Start",
    /** Nudge if they hit go with an empty box. */
    needInput: "go on then — give us a product or a url to chew on.",
    /** A quiet line under the input — reassurance, not config. */
    reassurance: "spend waits for your yes. sends follow your workspace policy, with receipts.",
  },

  /** SURFACE 1 · step 2 — the fleet wakes and reads the real site, then narrates a real finding. */
  reading: {
    /** Status while scout is actually reading the site. */
    working: "scout is nosing through your site. we won't judge. much.",
    /** The intros the fleet drops in the thread as they wake (named leads, house voice). */
    intros: [
      { who: "scout", line: "right, i read the whole thing. found something." },
      { who: "quill", line: "i'll write the words. the good ones." },
      { who: "echo", line: "and i'll make it loud. tastefully loud." },
    ] as const,
    /** Prefix for the real, site-derived finding scout reads out. The finding text comes from the provider. */
    findingLead: "ok this one's worth saying out loud —",
    /** Honest degrade if we genuinely couldn't read the site (offline / bad url) — never a faked finding. */
    error: "couldn't get into your site just now. give it another go, or try a different url.",
    /** Move on to the magic. */
    next: "nice. now let's plug in your actual stuff →",
    /** Live default: move the user into the iMessage-first workspace room instead of a connector theater. */
    openRoom: "text the team in iMessage →",
  },

  /**
   * SURFACE 1 · step 3 — THE MAGIC when the connectors are real. The public default must not pretend OAuth
   * happened; if the provider cannot connect a tool, the user sees the honest unavailable copy below.
   */
  connect: {
    sectionTitle: "let's borrow your tools. one at a time, no funny business.",
    allow: "allow",
    allowing: "plugging in…",
    skip: "skip for now",
    skipNote: "carry on with the site read. accounts can come later.",
    unavailable: "not hooked up yet. we'd rather tell you than do a little theatre.",
    realConnections: "open real connections",
    /** Shown the instant a connection lands, above its real result. */
    doneBadge: "connected",
    /** After the last connection's payoff — onto the real deliverable. */
    toDeliverable: "ok. watch this →",
    /** Per-connector prompt + the framing line above the real result it produces. */
    gmail: {
      tool: "gmail",
      prompt: "lend us your gmail for a sec? best behaviour, promise.",
      resultLead: "already drafted you a reply to a warm lead sitting in your inbox:",
    },
    social: {
      tool: "reddit / x",
      prompt: "let us peek at reddit and x? we'll be useful, not weird.",
      resultLead: "found 3 threads where you'd genuinely help. drafts ready:",
    },
    site: {
      tool: "your site",
      prompt: "give us the keys to your site? we'll wipe our feet.",
      resultLead: "here's your hero, rewritten and ready to publish:",
    },
  },

  /** SURFACE 1 · step 4 — one real deliverable, one approve, it ships. Spend stays human-gated. */
  deliverable: {
    eyebrow: "your first real one",
    /** While we put it together. */
    building: "stitching it together from your actual accounts…",
    buildingSiteOnly: "stitching it together from the site read…",
    siteOnly: "site-read draft. connect real accounts before ipop drafts replies or queues anything to publish.",
    /** The "what happens if you say yes" line — honest, reassuring. */
    consequence: "say yes and this publishes. nothing's sent and nothing's charged.",
    /** The approve / reject pair. */
    approve: "ship it",
    reject: "nah, redo",
    /** After a reject — the take-two beat. */
    redo: "yeah that was rubbish, take two.",
    /** The money gate — only shown for a deliverable that would actually spend or send. */
    moneyGate: "this one costs actual money. your call, big spender.",
  },

  /** SURFACE 1 · the payoff — small delight when it ships. */
  shipped: {
    headline: "shipped. that's a real thing you just did.",
    sub: "your fleet's awake and they've got your accounts. from here, they keep going inside your policy — spend still waits for your yes.",
    /** Into the everyday shell. */
    enter: "take me in →",
    /** The bigger celebration we're saving for the first paying customer (#784 motion spec). */
    firstCustomer: "oi. someone just PAID you. go scream into a pillow.",
  },

  /** Empty-thread filler used if a step has nothing yet. */
  empty: "bit quiet in here. give us a product and we'll cause a scene.",
} as const;
