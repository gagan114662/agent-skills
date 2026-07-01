/**
 * Brand-config tests (#122).
 *
 * Two guarantees:
 *  1. The deployed defaults describe **ipop**, never the internal "Reload" name.
 *  2. Product-chrome components contain NO hardcoded brand strings — they must read from `brand.ts`.
 *     This is the test that keeps a future edit from re-hardcoding "Reload" (or any brand) into the UI.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  BRAND,
  VOICE,
  DEPARTMENT_SPECTRUM,
  departmentColor,
  applyBrand,
  FLEET,
  agentColor,
  LANDING,
  LAUNCH_READINESS,
  PRICING,
  SECURITY,
  SITE,
  SUPPORT_CONTACT,
  CONTACT,
  COMPANY,
  ASK_AI,
  askAiLinks,
  PAYWALL,
  BRAND_ASSETS,
  WORKSPACE,
  STORY,
  FAQ,
  APPROVAL_POLICY,
  BILLING,
  CONSOLE,
  consoleWaitingChip,
  consoleNextAsk,
  consoleOvernightSummary,
  consoleBriefLaunched,
  consoleBriefConnect,
  CHANNEL_STARTERS,
  DEFAULT_STARTERS,
  starterPromptsFor,
  LEGAL,
  REFUND_POLICY,
} from "./brand.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("brand defaults", () => {
  it("are ipop, not the internal platform name", () => {
    expect(BRAND.name).toBe("ipop");
    expect(BRAND.title).toMatch(/ipop/);
    // "Reload" is internal-only — it must never leak into any product-facing brand value.
    for (const value of Object.values(BRAND)) {
      expect(value.toLowerCase()).not.toContain("reload");
    }
  });

  it("expose every field product chrome needs", () => {
    for (const key of ["name", "mark", "title", "tagline", "accent"] as const) {
      expect(BRAND[key], `BRAND.${key}`).toBeTruthy();
    }
  });

  it("applyBrand stamps the document title and accent custom property", () => {
    applyBrand({ name: "Test", mark: "★", title: "Test Title", tagline: "t", accent: "#123456" });
    expect(document.title).toBe("Test Title");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#123456");
  });
});

describe("pop identity (#138)", () => {
  it("uses Pop Vermilion as the accent", () => {
    expect(BRAND.accent.toLowerCase()).toBe("#ff4524");
  });

  it("carries the Innocent-school house voice with the sign-off", () => {
    expect(VOICE.signOff).toBe("made by robots, steered by humans.");
    for (const key of ["loading", "emptyChannel", "noMessages", "offlineTitle", "offlineBody"] as const) {
      expect(VOICE[key], `VOICE.${key}`).toBeTruthy();
    }
  });

  it("maps the eight marketing departments to a spectrum, keyed by channel name", () => {
    expect(Object.keys(DEPARTMENT_SPECTRUM).sort()).toEqual([
      "ads",
      "analytics",
      "brand",
      "content",
      "email",
      "reach",
      "seo",
      "social",
    ]);
    expect(departmentColor("seo")).toBe("#ff4524");
    expect(departmentColor("brand")).toBe("#b07bff");
    expect(departmentColor("general")).toBeUndefined(); // shared rooms have no department hue
    expect(departmentColor(null)).toBeUndefined();
  });

  it("the stylesheet :root carries the Paper/Ink/Vermilion palette", () => {
    const css = readFileSync(resolve(HERE, "styles.css"), "utf8");
    expect(css).toMatch(/--paper:\s*#f6f1e7/i);
    expect(css).toMatch(/--ink:\s*#171310/i);
    expect(css).toMatch(/--vermilion:\s*#ff4524/i);
    // The playful motion curve from the brand book.
    expect(css).toMatch(/cubic-bezier\(0\.2,\s*1\.4,\s*0\.3,\s*1\)/);
    // Motion respects reduced-motion.
    expect(css).toMatch(/prefers-reduced-motion/);
  });
});

describe("landing fleet + copy (#149)", () => {
  it("names the eight marketing specialists, each tied to a real department hue", () => {
    expect(FLEET).toHaveLength(8);
    const handles = FLEET.map((a) => a.handle);
    expect(new Set(handles).size).toBe(8); // no duplicates
    for (const agent of FLEET) {
      expect(agent.name, agent.handle).toBeTruthy();
      expect(agent.personality, agent.handle).toBeTruthy();
      // Every agent's department keys the spectrum, and agentColor (by display name, #145) resolves
      // to that same hue — the landing roster and the in-app avatars wear one colour per agent.
      expect(DEPARTMENT_SPECTRUM[agent.department], agent.handle).toBeTruthy();
      expect(agentColor(agent.name)).toBe(departmentColor(agent.department));
    }
  });

  it("covers all eight departments exactly once", () => {
    expect(FLEET.map((a) => a.department).sort()).toEqual(Object.keys(DEPARTMENT_SPECTRUM).sort());
  });

  it("the chip-cluster section states a specialist count that matches the chips shown (#303)", () => {
    // Section 01's visual is DepartmentChips, which renders one chip per FLEET agent. The copy must
    // claim exactly that many specialists — "says seven, shows eight" erodes trust on the conversion page.
    const chipStory = STORY.find((s) => s.visual === "department");
    expect(chipStory, "expected a story section paired with the department chips").toBeDefined();

    const COUNT_WORD: Record<number, string> = { 7: "seven", 8: "eight", 9: "nine", 10: "ten" };
    const word = COUNT_WORD[FLEET.length];
    expect(word, `add a count word for FLEET.length=${FLEET.length}`).toBeTruthy();
    expect(chipStory!.body).toContain(`${word} specialists`);

    // The enumerated function list (between the em-dashes) carries one entry per chip, so every shown
    // agent — including Comet (outbound) — has a described specialty.
    const enumerated = chipStory!.body.match(/specialists — ([^—]+) —/);
    expect(enumerated, "section 01 should enumerate the specialist functions").not.toBeNull();
    const functions = enumerated![1]!.split(",").map((s) => s.trim()).filter(Boolean);
    expect(functions).toHaveLength(FLEET.length);

    // No landing copy may claim the old, smaller count anywhere on the page.
    const copyBlob = JSON.stringify({ STORY, FAQ, LANDING });
    expect(copyBlob).not.toContain("seven specialists");
  });

  it("carries hero copy, three how-it-works steps, and a pricing teaser of three plans", () => {
    expect(LANDING.hero.ctaPrimary).toBeTruthy();
    expect(LANDING.hero.ctaSecondary).toBeTruthy();
    expect(LANDING.steps).toHaveLength(3);
    expect(LANDING.plans).toHaveLength(3);
    expect(LANDING.plans.filter((p) => p.featured)).toHaveLength(1); // one recommended tier
  });

  it("keeps the public approval/autonomy contract consistent (#1180)", () => {
    expect(APPROVAL_POLICY.money).toMatch(/paid ad spend|approval/i);
    expect(APPROVAL_POLICY.external).toMatch(/workspace policy/i);
    expect(APPROVAL_POLICY.internal).toMatch(/do not need approval/i);

    const approvalFaq = FAQ.items.find((item) => /approval/i.test(item.q));
    expect(approvalFaq?.a).toContain(APPROVAL_POLICY.money);
    expect(approvalFaq?.a).toContain(APPROVAL_POLICY.external);
    expect(approvalFaq?.a).toContain(APPROVAL_POLICY.internal);

    const publicCopy = JSON.stringify({ LANDING, STORY, FAQ });
    expect(publicCopy).not.toMatch(/Money\s*[—-]\s*and only money/i);
    expect(publicCopy).not.toMatch(/nothing leaves[^.?!]*(without|unless)[^.?!]*(yes|approval|nod)/i);
    expect(publicCopy).toMatch(/money waits|spend/i);
    expect(publicCopy).toMatch(/workspace policy/i);
  });

  it("every plan carries a stable key (for /signup?plan=) and 'what you get' highlights (#214)", () => {
    const keys = LANDING.plans.map((p) => p.key);
    expect(keys).toEqual(["starter", "pro", "agency"]); // mirror billing/plans.ts, ascending
    expect(new Set(keys).size).toBe(3); // unique — the signup hand-off needs one key per plan
    for (const plan of LANDING.plans) {
      expect(plan.key, plan.name).toBeTruthy();
      expect(plan.highlights.length, plan.name).toBeGreaterThan(0);
    }
  });

  it("scripts a vignette that ends on a completed task (the confetti beat)", () => {
    expect(LANDING.vignette.length).toBeGreaterThan(2);
    expect(LANDING.vignette.some((line) => line.done)).toBe(true);
    // Every agent line references a real fleet handle (so the bubble can wear its colour).
    const handles = new Set(FLEET.map((a) => a.handle));
    for (const line of LANDING.vignette) {
      if (line.from !== "you") expect(handles.has(line.from), line.from).toBe(true);
    }
  });
});

describe("landing workspace simulation copy (#165)", () => {
  it("models a complete sidebar: pinned rooms + every department channel + DMs", () => {
    const titles = WORKSPACE.sidebar.map((s) => s.title);
    expect(titles).toContain("Pinned");
    expect(titles).toContain("Departments");
    expect(titles).toContain("Direct messages");
    // The Departments group carries one channel per spectrum hue, each tied to a real department.
    const depts = WORKSPACE.sidebar.find((s) => s.title === "Departments")!;
    expect(depts.items).toHaveLength(Object.keys(DEPARTMENT_SPECTRUM).length);
    for (const ch of depts.items) {
      expect(ch.dept, ch.name).toBeTruthy();
      expect(DEPARTMENT_SPECTRUM[ch.dept!], ch.name).toBeTruthy();
    }
    // The pinned shared rooms the issue calls out are present.
    const pinned = WORKSPACE.sidebar.find((s) => s.title === "Pinned")!.items.map((i) => i.name);
    expect(pinned).toContain("#launch");
    expect(pinned).toContain("#general");
    // ⌘K search affordance.
    expect(WORKSPACE.searchHint).toMatch(/⌘K/);
  });

  it("scripts a whole day-arc with task cards, a QA result, and an approval the human answers", () => {
    const kinds = new Set(WORKSPACE.timeline.map((e) => e.kind));
    for (const k of ["message", "task", "qa", "approval"] as const) {
      expect(kinds.has(k), k).toBe(true);
    }
    // A task card carries an id + status ("T-12 IN PROGRESS").
    const task = WORKSPACE.timeline.find((e) => e.kind === "task");
    expect(task && "id" in task && task.id).toBeTruthy();
    expect(task && "status" in task && task.status).toBeTruthy();
    // The QA result reads like real QA (passing count + a specific caught regression).
    const qa = WORKSPACE.timeline.find((e) => e.kind === "qa");
    expect(qa && "total" in qa && qa.total).toBeGreaterThan(0);
    expect(qa && "note" in qa && qa.note).toBeTruthy();
    // The approval card has the human's reply ("ship it").
    const approval = WORKSPACE.timeline.find((e) => e.kind === "approval");
    expect(approval && "reply" in approval && approval.reply).toBeTruthy();
    // The day ends on a completed beat (the confetti line).
    expect(WORKSPACE.timeline.some((e) => e.kind === "message" && e.done)).toBe(true);
    // Every agent message references a real fleet handle so the bubble can wear its colour.
    const handles = new Set(FLEET.map((a) => a.handle));
    for (const e of WORKSPACE.timeline) {
      if (e.kind === "message" && e.from !== "you") expect(handles.has(e.from), e.from).toBe(true);
    }
  });

  it("has four numbered story sections, each with a known product-true visual", () => {
    expect(STORY).toHaveLength(4);
    expect(STORY.map((s) => s.n)).toEqual(["01", "02", "03", "04"]);
    const visuals = new Set(["department", "mission", "approvals", "memory"]);
    for (const s of STORY) {
      expect(s.title, s.n).toBeTruthy();
      expect(s.body, s.n).toBeTruthy();
      expect(visuals.has(s.visual), s.visual).toBe(true);
    }
    // The four visuals are distinct — each story shows a different slice of the app.
    expect(new Set(STORY.map((s) => s.visual)).size).toBe(4);
  });

  it("carries a substantive FAQ (8–11 answered questions)", () => {
    expect(FAQ.items.length).toBeGreaterThanOrEqual(8);
    expect(FAQ.items.length).toBeLessThanOrEqual(11);
    for (const item of FAQ.items) {
      expect(item.q, item.q).toBeTruthy();
      expect(item.a.length, item.q).toBeGreaterThan(40); // real answers, not one-liners
    }
  });

  it("frames pricing as the in-app billing screen, with a current plan drawn from the catalog", () => {
    const planNames = LANDING.plans.map((p) => p.name);
    expect(planNames).toContain(BILLING.currentPlan);
    expect(BILLING.navItems).toContain(BILLING.billingLabel);
  });

  it("exposes sticky anchor nav and a multi-column footer", () => {
    expect(LANDING.anchors.length).toBeGreaterThanOrEqual(3);
    for (const a of LANDING.anchors) expect(a.href.startsWith("#"), a.href).toBe(true);
    expect(LANDING.footer.product.length).toBeGreaterThan(0);
    expect(LANDING.footer.resources.length).toBeGreaterThan(0);
    expect(LANDING.footer.resources).toContainEqual({
      href: SUPPORT_CONTACT.href,
      label: SUPPORT_CONTACT.label,
    });
    expect(LANDING.footer.product).toContainEqual({ href: COMPANY.href, label: COMPANY.navLabel });
    expect(LANDING.footer.product).toContainEqual({ href: "/refund-policy", label: "Refund policy" });
    expect(LANDING.footer.product).toContainEqual({
      href: LEGAL.dpa.href,
      label: LEGAL.dpa.navLabel,
    });
    expect(CONTACT.consentHelp).toContain("data-subject-rights");
    expect(CONTACT.errorNote).toContain(SUPPORT_CONTACT.email);
    expect(CONTACT.bookingHref).toBe("/start?source=landing_booking_cta");
    expect(CONTACT.trialHref).toContain("/start");
    expect(SITE.support).toBe(SUPPORT_CONTACT);
    expect(LANDING.footer.social.map((s) => s.href).filter((href) => href.startsWith("/social/"))).toEqual([]);
  });
});

describe("company/procurement page copy (#1188)", () => {
  it("does not fall back to vague operator wording for legal/procurement facts", () => {
    const details = COMPANY.details.map((detail) => `${detail.label}: ${detail.value}`).join("\n");

    expect(details).not.toMatch(/ipop\.ai operator/i);
    expect(details).not.toMatch(/not yet published/i);
    expect(details).toMatch(/Gagan Arora, owner\/operator of ipop\.ai/i);
    expect(details).toMatch(/support@ipop\.ai/i);
    expect(details).toMatch(/W-9|tax|vendor/i);
  });

  it("lists the buyer packet and all public review links", () => {
    const packet = COMPANY.sections.map((section) => `${section.title}: ${section.body}`).join("\n");

    for (const term of ["contracting entity", "tax", "security questionnaire", "subprocessors", "DPA", "terms", "privacy", "refund"]) {
      expect(packet, term).toMatch(new RegExp(term, "i"));
    }

    expect(COMPANY.legalLinks).toEqual(
      expect.arrayContaining([
        { href: LEGAL.terms.href, label: LEGAL.terms.navLabel },
        { href: LEGAL.privacy.href, label: LEGAL.privacy.navLabel },
        { href: LEGAL.dpa.href, label: LEGAL.dpa.navLabel },
        { href: "/security", label: SECURITY.navLabel },
        { href: "/refund-policy", label: REFUND_POLICY.navLabel },
        { href: SUPPORT_CONTACT.href, label: SUPPORT_CONTACT.label },
      ]),
    );
  });

  it("footer links only point at public routes or in-page anchors (#link-qa)", () => {
    const publicPrefixes = [
      "/security",
      "/pricing",
      "/blog",
      "/guides",
      "/stories",
      "/changelog",
      "/compare",
      "/company",
      "/refund-policy",
      "/terms",
      "/privacy",
      "/dpa",
    ];
    const links = [
      ...LANDING.footer.product,
      ...LANDING.footer.resources,
      ...LANDING.footer.social,
    ];
    for (const link of links) {
      expect(
        link.href.startsWith("#") ||
          link.href.startsWith("mailto:") ||
          publicPrefixes.some((prefix) => link.href === prefix || link.href.startsWith(prefix + "/")),
        link.label + " -> " + link.href,
      ).toBe(true);
    }
    expect(links.map((l) => l.href).join(" ")).not.toContain("/social/");
  });
});

describe("pricing page + trial framing copy (#214)", () => {
  it("carries the focused pricing-page copy and a per-plan CTA", () => {
    expect(PRICING.title).toBeTruthy();
    expect(PRICING.sub).toBeTruthy();
    expect(PRICING.planCta).toBeTruthy();
    expect(PRICING.footnote.toLowerCase()).toMatch(/self-serve checkout|stripe/);
    expect(PRICING.monthlyLabel).toBeTruthy();
    expect(PRICING.annualLabel).toBeTruthy();
    expect(PRICING.faqMatch.length).toBeGreaterThan(0);
  });

  it("frames the chosen plan as a quick checkout handoff", () => {
    expect(PRICING.trial.eyebrow).toBeTruthy();
    expect(PRICING.trial.onPlan("Pro")).toContain("Pro");
    expect(PRICING.trial.onPlan("Pro").toLowerCase()).toMatch(/stripe|checkout/);
    expect(PRICING.trial.generic.toLowerCase()).toMatch(/checkout|sales call/);
  });

  it("its faq filters surface at least one real pricing question from the shared FAQ", () => {
    const matched = FAQ.items.filter((item) => PRICING.faqMatch.some((re) => re.test(item.q)));
    expect(matched.map((item) => item.q)).toEqual(
      expect.arrayContaining([
        "What does it cost, and what's the difference between Starter and Pro?",
        "What do priority autonomy and deploy-to-live mean?",
      ]),
    );
    expect(matched.some((item) => /three agent seats|ten seats|department fleet/i.test(item.a))).toBe(true);
    expect(matched.some((item) => /priority autonomy|deploy-to-live/i.test(item.a))).toBe(true);
  });

  it("has a readiness readout that separates real, dogfood, demo, and blocked proof", () => {
    expect(LAUNCH_READINESS.checklist.map((row) => row.state)).toEqual(
      expect.arrayContaining(["Live", "Dogfood", "Blocked"]),
    );
    expect(LAUNCH_READINESS.proof.map((row) => row.label)).toEqual(["Live", "Dogfood", "Demo", "Blocked"]);
    expect(LAUNCH_READINESS.codex.body).toMatch(/backend/i);
    expect(LAUNCH_READINESS.pricing.body).toContain("$199");
  });
});

describe("security trust page copy (#151) — honest by construction", () => {
  it("lists several real, shipped guarantees", () => {
    expect(SECURITY.guarantees.length).toBeGreaterThanOrEqual(5);
    for (const g of SECURITY.guarantees) {
      expect(g.title).toBeTruthy();
      expect(g.body).toBeTruthy();
    }
    // The headline guarantees the issue calls out must be present (mechanisms that truly exist).
    const titles = SECURITY.guarantees.map((g) => g.title.toLowerCase()).join(" | ");
    expect(titles).toMatch(/approval/);
    expect(titles).toMatch(/isolation/);
    expect(titles).toMatch(/kill switch/);
    expect(titles).toMatch(/budget/);
    expect(titles).toMatch(/audit/);
  });

  it("flags every roadmap item with an explicit status (never a current claim)", () => {
    expect(SECURITY.roadmap.length).toBeGreaterThan(0);
    for (const r of SECURITY.roadmap) {
      expect(r.status, r.title).toBeTruthy();
      // A roadmap status must read as not-done: "planned" / "not yet" / "designed seam" / "partial".
      expect(r.status.toLowerCase(), r.title).toMatch(/planned|not yet|seam|partial/);
    }
    // SOC2 remains roadmap-only; GDPR DPA now lives in the public legal DPA page, not as a security cert.
    const roadmapText = SECURITY.roadmap.map((r) => `${r.title} ${r.status} ${r.body}`).join(" ");
    expect(roadmapText).toMatch(/SOC ?2/i);
    expect(LEGAL.dpa.sub).toMatch(/GDPR Article 28/i);
    const guaranteeText = SECURITY.guarantees.map((g) => `${g.title} ${g.body}`).join(" ");
    expect(guaranteeText).not.toMatch(/SOC ?2/i); // never claimed as a current guarantee
    expect(guaranteeText).not.toMatch(/GDPR/i);
    // Any mention of being "certified" must be negated (e.g. "not yet certified") — never a bare claim.
    for (const r of SECURITY.roadmap) {
      const blob = `${r.status} ${r.body}`.toLowerCase();
      if (blob.includes("certified")) expect(blob).toMatch(/not (yet )?certified|not certified/);
    }
  });

  it("states plainly that we hold no current certifications", () => {
    expect(SECURITY.notClaimed.toLowerCase()).toMatch(/no .*certification/);
  });
});

describe("marketing-site machine copy (#153)", () => {
  it("carries the five marketing-site nav sections and the dogfood credit", () => {
    expect(SITE.nav.map((n) => n.href)).toEqual(["/compare", "/stories", "/guides", "/changelog", "/brand"]);
    // The twist: every content page is footed "maintained by Quill".
    expect(SITE.maintainedBy).toMatch(/quill/i);
  });

  it("builds Ask-AI deep links for the three assistants with the prompt URL-encoded", () => {
    const links = askAiLinks();
    expect(links.map((l) => l.key)).toEqual(["chatgpt", "claude", "perplexity"]);
    const encoded = encodeURIComponent(ASK_AI.prompt);
    for (const link of links) {
      expect(link.href).toContain(encoded);
      expect(link.href).not.toContain(" "); // a raw space would be a broken deep link
    }
    // ChatGPT/Claude/Perplexity each get their own provider origin.
    expect(links[0]!.href).toContain("chatgpt.com");
    expect(links[1]!.href).toContain("claude.ai");
    expect(links[2]!.href).toContain("perplexity.ai");
  });

  it("lets a caller override the Ask-AI prompt", () => {
    expect(askAiLinks("custom question")[0]!.href).toContain(encodeURIComponent("custom question"));
  });

  it("the soft paywall names the plan and points at pricing", () => {
    expect(PAYWALL.cta).toBeTruthy();
    expect(PAYWALL.onPlan("Pro")).toContain("Pro");
  });

  it("the brand kit exposes the Paper/Ink/Vermilion palette", () => {
    const hexes = BRAND_ASSETS.palette.map((s) => s.hex.toLowerCase());
    expect(hexes).toContain("#ff4524"); // Pop Vermilion
    expect(BRAND_ASSETS.palette).toHaveLength(3);
  });
});

describe("console redesign copy (board + standup)", () => {
  it("names the three v5 board lanes exactly: Work in progress / Spend approval / Done", () => {
    expect(CONSOLE.columns.running).toBe("Work in progress");
    // #243: the middle lane holds ONLY money decisions; non-money work flows straight to Done.
    expect(CONSOLE.columns.waiting).toBe("Spend approval");
    expect(CONSOLE.columns.shipped).toBe("Done");
    // The five per-project settings tabs the mockup defines.
    for (const k of ["general", "models", "agents", "budget", "approvals"] as const) {
      expect(CONSOLE.settings.tabs[k]).toBeTruthy();
    }
  });

  it("carries the v5 drawer copy (steps, why link, the approve pair) and the two-pane shell utilities", () => {
    for (const k of ["doing", "why", "approve", "notYet", "notYetReason", "steerPlaceholder", "send"] as const) {
      expect(CONSOLE.peek[k], `peek.${k}`).toBeTruthy();
    }
    // The "why did it do this?" link reads as a question into the audit trail.
    expect(CONSOLE.peek.why).toMatch(/why/i);
    // The shell utilities that replace the removed top nav (account actions live in the left footer).
    for (const k of ["signOut", "settings"] as const) expect(CONSOLE.shell[k], `shell.${k}`).toBeTruthy();
  });

  it("carries the approvals-clear moment and the local-model connected label", () => {
    expect(CONSOLE.approvalsClear.headline).toMatch(/All clear/);
    expect(consoleNextAsk()).toMatch(/^Next likely ask: .+\.$/);
    expect(consoleNextAsk("echo's Friday posts")).toContain("echo's Friday posts");
    expect(CONSOLE.settings.models.localConnected).toBe("connected");
    // Keys are presented as write-only/sealed — never read back.
    expect(CONSOLE.settings.models.keysHint).toMatch(/write-only|sealed/);
  });

  it("builds the header chip + overnight summary in the house voice (pluralized)", () => {
    expect(consoleWaitingChip(1)).toBe("1 waiting on you");
    expect(consoleOvernightSummary(3, 1, "$4.10")).toBe("3 shipped · 1 needs your yes · $4.10 overnight");
    expect(consoleOvernightSummary(0, 2, "$0.00")).toContain("2 need your yes");
  });

  // #235: the owner brief composer copy — the working control that replaces the passive board.
  it("carries the brief composer: every department lead + the launched/connect confirmations", () => {
    expect(CONSOLE.brief.title).toBeTruthy();
    expect(CONSOLE.brief.sub).toBeTruthy();
    expect(CONSOLE.brief.submit).toBeTruthy();
    expect(CONSOLE.brief.placeholder).toBeTruthy();
    // The five acquisition leads (#235) plus Lens (analytics) and Mark (brand) (#288) — every
    // department agent is briefable, each a real @handle.
    const handles = CONSOLE.brief.leads.map((l) => l.handle);
    expect(handles).toEqual(["scout", "echo", "quill", "postmark", "bid", "lens", "mark"]);
    for (const l of CONSOLE.brief.leads) {
      expect(l.name, l.handle).toBeTruthy();
      expect(l.dept, l.handle).toBeTruthy();
      // Every brief lead wears its department hue (resolved by display name, #145).
      expect(agentColor(l.name), l.handle).toBeTruthy();
    }
    // The outcome lines name the lead.
    expect(consoleBriefLaunched("Scout")).toMatch(/^Scout .+Work in progress/);
    expect(consoleBriefConnect("Scout")).toMatch(/^Scout .+connect Claude/i);
  });
});

describe("empty-channel starter prompts (#509)", () => {
  it("gives every department channel 2–3 concrete @-mention first actions", () => {
    // Acceptance: every department channel suggests 2–3 first actions, each a real @-mention brief.
    const handleByDept: Record<string, string> = Object.fromEntries(
      FLEET.map((a) => [a.department, a.handle]),
    );
    for (const dept of Object.keys(DEPARTMENT_SPECTRUM)) {
      const starters = CHANNEL_STARTERS[dept];
      expect(starters, `#${dept} has starters`).toBeTruthy();
      expect(starters!.length, `#${dept} count`).toBeGreaterThanOrEqual(2);
      expect(starters!.length, `#${dept} count`).toBeLessThanOrEqual(3);
      // Every prompt is a concrete, non-trivial brief that mentions that department's named lead.
      for (const prompt of starters!) {
        expect(prompt.length, prompt).toBeGreaterThan(15);
        expect(prompt, prompt).toContain(`@${handleByDept[dept]}`);
      }
    }
  });

  it("falls back to a generic cross-fleet set for channels without a department", () => {
    expect(DEFAULT_STARTERS.length).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_STARTERS.length).toBeLessThanOrEqual(3);
    // #general / #launch / unknown / blank all get the generic set, never an empty list.
    expect(starterPromptsFor("general")).toBe(DEFAULT_STARTERS);
    expect(starterPromptsFor("launch")).toBe(DEFAULT_STARTERS);
    expect(starterPromptsFor(null)).toBe(DEFAULT_STARTERS);
    expect(starterPromptsFor(undefined)).toBe(DEFAULT_STARTERS);
    expect(starterPromptsFor("").length).toBeGreaterThanOrEqual(2);
  });

  it("resolves department channels by name, tolerating a leading # and case", () => {
    expect(starterPromptsFor("seo")).toBe(CHANNEL_STARTERS.seo);
    expect(starterPromptsFor("#seo")).toBe(CHANNEL_STARTERS.seo);
    expect(starterPromptsFor("SEO")).toBe(CHANNEL_STARTERS.seo);
    expect(starterPromptsFor("#Ads")).toBe(CHANNEL_STARTERS.ads);
  });

  it("never suggests nothing — every resolved set has at least two actions", () => {
    for (const name of ["seo", "social", "content", "email", "ads", "analytics", "brand", "reach", "general", "anything-else"]) {
      expect(starterPromptsFor(name).length, name).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("no hardcoded brand strings in product chrome", () => {
  // Components that render the product shell. Every brand string here must come from BRAND.*.
  const CHROME_COMPONENTS = [
    // Workspace.tsx is now a trivial full-height wrapper around ConsoleView (console v5 removed the top
    // nav), so it carries no brand copy — the scan covers the two-pane console components below instead.
    "components/AuthGate.tsx",
    "components/ChannelSidebar.tsx",
    // The workspace/product switcher (#510): the top-left title menu reads its copy from CONSOLE.coordination
    // .switcher; the current workspace label falls back to the workspace id (the product name comes from data).
    "components/WorkspaceSwitcher.tsx",
    // The public landing (#149 → #165) is the most brand-heavy surface — every word must come from
    // brand.ts. The #165 full-workspace simulation splits across several components; scan them all.
    "components/landing/Landing.tsx",
    // The dedicated public pricing page (#214).
    "components/landing/PricingPage.tsx",
    "components/landing/CompanyPage.tsx",
    "components/landing/WorkspaceSim.tsx",
    "components/landing/Vignettes.tsx",
    "components/landing/BillingScreen.tsx",
    "components/landing/LaunchReadiness.tsx",
    "components/landing/Faq.tsx",
    "components/landing/ContactForm.tsx",
    // The public trust page (#151).
    "components/landing/Security.tsx",
    // The marketing-site machine (#153): every page reads its copy from brand.ts.
    "components/site/SiteShell.tsx",
    "components/site/SectionPage.tsx",
    "components/site/Brand.tsx",
    "components/site/SoftPaywall.tsx",
    "components/site/MarketingSite.tsx",
    // The console redesign (board + standup) — the primary product surface. Every word comes from the
    // CONSOLE block in brand.ts; even the copy-free StatusGlyph reads its braille grammar from brand.
    "components/console/ConsoleView.tsx",
    "components/console/StandupPanel.tsx",
    "components/console/ConsoleEmptyState.tsx",
    "components/console/Board.tsx",
    "components/console/BriefComposer.tsx",
    "components/console/PeekDrawer.tsx",
    "components/console/ReportsView.tsx",
    "components/console/ProjectSettingsSheet.tsx",
    "components/console/StatusGlyph.tsx",
    // The agent-coordination surface (#352): the overlay wrapper reads its copy from CONSOLE.coordination
    // (the orphaned panels it mounts carry their own VOICE copy and are not scanned here).
    "components/console/CoordinationView.tsx",
    // Settings → Connect external accounts (#192/#231): every word comes from EXTERNAL_ACCOUNTS.
    "components/ExternalAccounts.tsx",
    "components/ExternalAccountsPanel.tsx",
    // Settings → Connections (#258): every word comes from CONNECTIONS (connector labels come from data).
    "components/Connections.tsx",
    "components/ConnectionsPanel.tsx",
    // Settings → Agent Garden (#284): every word comes from GARDEN (agent names/summaries come from data).
    "components/Garden.tsx",
    "components/GardenPanel.tsx",
    // Settings → Brand kit (#271): every word comes from BRAND_KIT.
    "components/BrandKitPanel.tsx",
    // Settings → "What are we marketing?" (#502): every word comes from MARKETING_TARGET.
    "components/MarketingTargetPanel.tsx",
  ];

  // Forbidden literals anywhere in chrome source: the internal name and the deployed brand name.
  // Comments are fine to mention "Reload" for context, so we only scan JSX/string content lines.
  for (const rel of CHROME_COMPONENTS) {
    it(`${rel} reads brand from brand.ts (no literal "Reload"/"ipop")`, () => {
      const src = readFileSync(resolve(HERE, rel), "utf8");
      const codeLines = src
        .split("\n")
        .filter((line) => {
          const t = line.trim();
          return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
        })
        .join("\n");
      expect(codeLines).not.toMatch(/Reload/);
      expect(codeLines).not.toMatch(/ipop/i);
      // It must actually import the brand config rather than inline its own copy (any nesting depth).
      expect(src).toMatch(/from "(?:\.\.\/)+brand\.js"/);
    });
  }
});
