/**
 * The named-department roster (#371, ADR-0371) — a **pure**, dependency-free source of truth for the
 * reload.chat "team": the distinct, named agent personas the owner workspace lands inside so the members
 * rail and authored messages read as a real department (a Product owner/lead, an SEO, a Designer, a
 * Developer, QA, DevOps) instead of generic singletons.
 *
 * This is identity / display only. Each persona carries the same read/draft tool ceiling every fleet
 * agent does and **no send/spend tool** — anything that leaves the building still flows through the #13
 * human-approval gate (#200: personas can never widen scope or add an action path). The roster is
 * **configurable**: a deployment may rename a persona, change its role label, or recolor it via the
 * `department.roster` config overrides ({@link resolveDepartmentRoster}); the defaults below are the
 * reload.chat example team.
 *
 * Pure ⇒ unit-testable + extensible: adding a teammate is one entry here and the seeder / rail / registry
 * projection pick it up.
 */

/** Read/draft tools every teammate shares. Deliberately no send/post/email/spend capability (see #13). */
export const DEPARTMENT_DRAFT_TOOLS = ["Read", "Grep", "Glob", "WebSearch", "WebFetch"] as const;

/**
 * A named teammate bound to a department role. `handle` is the @-mentionable persona name (lowercase),
 * `role` the human-readable title shown in the members rail, `color` an accent hex (avatar / role chip),
 * `lead` marks the department owner. `summary` is the brand-voice one-liner the persona introduces itself
 * with; `systemPrompt` is its identity prompt (no send tool, draft-only, approval-gated).
 */
export interface DepartmentPersona {
  /** @-mentionable handle (lowercase, the persona's stable id in the team). */
  handle: string;
  /** Display name, e.g. "Hermes". */
  displayName: string;
  /** Department key (e.g. `product`, `seo`, `design`). Stable; not renamed by config overrides. */
  department: string;
  /** Human role / title shown in the rail, e.g. "Product owner". Configurable. */
  role: string;
  /** Accent color (7-char hex `#RRGGBB`) for the avatar / role chip. Configurable. */
  color: string;
  /** True for the department lead (the Product owner). Exactly one is the lead in the defaults. */
  lead: boolean;
  /** The brand-voice one-liner the persona introduces itself with. */
  summary: string;
  /** The identity system prompt the seeded persona carries (draft-only, approval-gated). */
  systemPrompt: string;
}

/** Per-handle overrides a deployment may apply (configurable names/roles/colors). All optional. */
export interface DepartmentPersonaOverride {
  /** Which default persona to override (matched by handle, case-insensitive). */
  handle: string;
  displayName?: string;
  role?: string;
  color?: string;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Build the identity prompt for a teammate — pure, derived from its role. No send/spend capability. */
function identityPrompt(displayName: string, handle: string, role: string, lead: boolean): string {
  const leadLine = lead
    ? "As the department lead you keep the team pointed at the goal and hand work to the right teammate by " +
      "@mentioning them. "
    : "";
  return (
    `You are ${displayName} (@${handle}), the ${role} on this department team. ` +
    `${leadLine}` +
    "You draft, review, and advise in your own voice, in-channel, for a human to approve. You carry no " +
    "send, post, or spend tool: anything that leaves the building waits for a human's yes through the " +
    "approval queue, and you never claim something was sent, posted, or spent. " +
    "Keep the house voice: warm, first-person plural, a little playful, receipts over adjectives."
  );
}

function persona(
  handle: string,
  displayName: string,
  department: string,
  role: string,
  color: string,
  lead: boolean,
  summary: string,
): DepartmentPersona {
  return {
    handle,
    displayName,
    department,
    role,
    color,
    lead,
    summary,
    systemPrompt: identityPrompt(displayName, handle, role, lead),
  };
}

/**
 * The default reload.chat team — the named department personas a fresh owner workspace is seeded with.
 * Order is presentation order (lead first). Handles are lowercase; colors are distinct accessible accents.
 * Configurable: a deployment overrides any of these via `department.roster` ({@link resolveDepartmentRoster}).
 */
export const DEFAULT_DEPARTMENT_ROSTER: readonly DepartmentPersona[] = [
  persona(
    "hermes",
    "Hermes",
    "product",
    "Product owner",
    "#6E56CF",
    true,
    "I'm Hermes. I keep us pointed at the one outcome that matters this week and hand each piece to whoever " +
      "does it best. Tell me the goal; I'll line up the team.",
  ),
  persona(
    "scout",
    "Scout",
    "seo",
    "SEO",
    "#2E9E5B",
    false,
    "Hi, I'm Scout. I read your site the way a crawler does and bring back where it trips — with the receipts.",
  ),
  persona(
    "lens",
    "Lens",
    "design",
    "Design",
    "#E5484D",
    false,
    "Lens here. I make it look like we meant it — clear hierarchy, honest spacing, no slop. Drafts land here first.",
  ),
  persona(
    "atlas",
    "Atlas",
    "development",
    "Developer",
    "#0091FF",
    false,
    "I'm Atlas. I turn the plan into working code, small and reviewable. Nothing ships without your nod.",
  ),
  persona(
    "sentinel",
    "Sentinel",
    "qa",
    "QA",
    "#F2A60D",
    false,
    "Sentinel, on watch. I try to break it before your users do and write down exactly how. Evidence over vibes.",
  ),
  persona(
    "echo",
    "Echo",
    "devops",
    "DevOps",
    "#00A3BF",
    false,
    "Echo here. I keep the pipes flowing — builds, deploys, the boring reliable stuff. Every release waits for approval.",
  ),
];

/**
 * Resolve the effective roster for a workspace: the {@link DEFAULT_DEPARTMENT_ROSTER} with any config
 * overrides applied (configurable names/roles/colors). Pure + total. Overrides are matched by handle
 * (case-insensitive); an override for an unknown handle is ignored (a roster never grows by override —
 * teammates are added in code so the registry/seed stay in sync). An invalid color override is dropped
 * (the default color is kept) so a bad config can never produce a broken accent. The handle/department/
 * lead structure is fixed; only the human-facing label/color/displayName are tunable.
 */
export function resolveDepartmentRoster(
  overrides?: readonly DepartmentPersonaOverride[],
): readonly DepartmentPersona[] {
  if (!overrides || overrides.length === 0) return DEFAULT_DEPARTMENT_ROSTER;
  const byHandle = new Map<string, DepartmentPersonaOverride>();
  for (const o of overrides) {
    if (o && typeof o.handle === "string") byHandle.set(o.handle.trim().toLowerCase(), o);
  }
  return DEFAULT_DEPARTMENT_ROSTER.map((p) => {
    const o = byHandle.get(p.handle);
    if (!o) return p;
    const displayName = typeof o.displayName === "string" && o.displayName.trim() ? o.displayName.trim() : p.displayName;
    const role = typeof o.role === "string" && o.role.trim() ? o.role.trim() : p.role;
    const color = typeof o.color === "string" && HEX_COLOR.test(o.color.trim()) ? o.color.trim() : p.color;
    return {
      ...p,
      displayName,
      role,
      color,
      // Keep the identity prompt in sync with a renamed display name / role.
      systemPrompt: identityPrompt(displayName, p.handle, role, p.lead),
    };
  });
}

/** The handles in a roster (default unless one is supplied). Pure. */
export function departmentHandles(roster: readonly DepartmentPersona[] = DEFAULT_DEPARTMENT_ROSTER): string[] {
  return roster.map((p) => p.handle);
}

/** The teammate for an @handle in a roster, or undefined. Case-insensitive. Pure + total. */
export function departmentPersonaForHandle(
  handle: string,
  roster: readonly DepartmentPersona[] = DEFAULT_DEPARTMENT_ROSTER,
): DepartmentPersona | undefined {
  const h = handle.trim().replace(/^@/, "").toLowerCase();
  return roster.find((p) => p.handle === h);
}

/** True iff `handle` names a teammate in the (default) roster. Pure + total. */
export function isDepartmentHandle(
  handle: string,
  roster: readonly DepartmentPersona[] = DEFAULT_DEPARTMENT_ROSTER,
): boolean {
  return departmentPersonaForHandle(handle, roster) !== undefined;
}
