/**
 * The task template gallery (#147, ADR-0147 §4 / slice 2). Pure data + a pure renderer. One registry
 * with two consumers: the channel composer pre-fills a message from it, and an automation stores a
 * `template_key` + `params` that the engine renders at run time — so "run it now" and "run it every
 * Monday" never duplicate a task definition. Each template targets a #123 marketing department; the
 * rendered body is the brief the draft-only department persona executes (any external send still
 * leaves through the #13 gate — these templates produce drafts, never sends).
 */

/** A declared template param. `placeholder` is the substituted-in default when a param is omitted. */
export interface TemplateParam {
  key: string;
  label: string;
  placeholder: string;
}

export interface TaskTemplate {
  key: string;
  /** The #123 department key whose persona runs this (seo|content|brand|email|ads|analytics). */
  department: string;
  title: string;
  description: string;
  /** The brief, with `{{param}}` placeholders substituted by {@link renderTemplate}. */
  body: string;
  params: TemplateParam[];
}

/**
 * Six prebuilt marketing task templates, one per producing department (the ona-equivalent of bug
 * triage / post-merge verify). Bodies instruct *draft + stop* — the persona never sends; a human
 * approves any outbound through #13.
 */
export const TASK_TEMPLATES: readonly TaskTemplate[] = [
  {
    key: "seo_audit",
    department: "seo",
    title: "SEO audit",
    description: "Crawl the site and report the highest-impact SEO fixes.",
    body:
      "Run an SEO audit of {{site}}. Check titles, meta descriptions, headings, broken links, " +
      "Core Web Vitals, and structured data. Draft a prioritized list of the top 10 fixes with the " +
      "expected impact of each. Post the findings as a draft — do not send anything externally.",
    params: [{ key: "site", label: "Site URL", placeholder: "our website" }],
  },
  {
    key: "content_calendar",
    department: "content",
    title: "Content calendar",
    description: "Draft a content calendar for the next stretch.",
    body:
      "Draft a content calendar covering the next {{weeks}} weeks on the theme \"{{topic}}\". For each " +
      "slot give a working title, the format, the target keyword, and a one-line angle. Post it as a draft.",
    params: [
      { key: "topic", label: "Theme", placeholder: "our product" },
      { key: "weeks", label: "Weeks", placeholder: "4" },
    ],
  },
  {
    key: "competitor_teardown",
    department: "brand",
    title: "Competitor teardown",
    description: "Tear down a competitor's positioning and messaging.",
    body:
      "Do a teardown of {{competitor}}: their positioning, messaging, pricing, and the gaps we can " +
      "exploit. Draft a one-page summary with three concrete recommendations for how we differentiate.",
    params: [{ key: "competitor", label: "Competitor", placeholder: "our main competitor" }],
  },
  {
    key: "email_sequence",
    department: "email",
    title: "Email sequence draft",
    description: "Draft a lifecycle email sequence.",
    body:
      "Draft a {{steps}}-email sequence for {{audience}}. Give each email a subject line, a preview " +
      "line, and the body copy, with the goal of each step. Draft only — do not send.",
    params: [
      { key: "audience", label: "Audience", placeholder: "new signups" },
      { key: "steps", label: "Emails", placeholder: "5" },
    ],
  },
  {
    key: "ad_copy_variants",
    department: "ads",
    title: "Ad copy variants",
    description: "Draft A/B ad copy variants.",
    body:
      "Draft {{variants}} ad copy variants for {{product}}. For each: a headline, primary text, and a " +
      "call to action, each testing a different angle. Draft only — do not spend or launch anything.",
    params: [
      { key: "product", label: "Product", placeholder: "our product" },
      { key: "variants", label: "Variants", placeholder: "5" },
    ],
  },
  {
    key: "analytics_digest",
    department: "analytics",
    title: "Analytics digest",
    description: "Summarize the period's analytics into a digest.",
    body:
      "Produce an analytics digest for the last {{period}}: traffic, conversion, top sources, and the " +
      "two or three trends worth acting on. Post the digest as a draft.",
    params: [{ key: "period", label: "Period", placeholder: "week" }],
  },
];

/** Look up a template by key, or undefined. */
export function getTemplate(key: string): TaskTemplate | undefined {
  return TASK_TEMPLATES.find((t) => t.key === key);
}

/** The templates a given department can run (the composer filters to the channel's department). */
export function templatesForDepartment(department: string): TaskTemplate[] {
  return TASK_TEMPLATES.filter((t) => t.department === department);
}

/**
 * Render a template's body, substituting every `{{param}}` with the supplied value or the param's
 * placeholder default. Unknown `{{tokens}}` are left intact (defensive — never throws). Pure.
 */
export function renderTemplate(key: string, params: Record<string, string>): string {
  const template = getTemplate(key);
  if (!template) return "";
  const defaults: Record<string, string> = {};
  for (const p of template.params) defaults[p.key] = p.placeholder;
  const merged: Record<string, string> = { ...defaults, ...params };
  return template.body.replace(/\{\{(\w+)\}\}/g, (match: string, name: string) => {
    const value = merged[name];
    if (value !== undefined && value.trim() !== "") return value;
    return defaults[name] ?? match;
  });
}
