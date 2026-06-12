/**
 * The agent browser tool surface (#174, ADR-0174). Pure, dependency-free data describing the tools a
 * session can drive its Playwright Chromium with. The split that matters for safety: **read-only**
 * tools (navigate / read_page / screenshot / scroll / wait) are free, while **side-effectful** tools
 * (click / type) mutate remote state and therefore route through the #13 human-approval gate. This
 * module is the single source of truth for that classification — `decide.ts` and the session both
 * consume it, and the unit job asserts it, so a new tool can never silently bypass the gate.
 */

/** Every tool the agent browser exposes. Stable + bounded (it is part of the receipt/audit vocabulary). */
export const BROWSER_TOOL_NAMES = [
  "navigate",
  "read_page",
  "screenshot",
  "scroll",
  "wait",
  "click",
  "type",
] as const;

export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];

/** One tool's metadata: its name, whether it mutates remote state, and whether it loads a new page. */
export interface BrowserToolSpec {
  name: BrowserToolName;
  /**
   * True iff invoking the tool can mutate remote state (a click on a button, typing into a field).
   * Side-effectful tools ALWAYS require a #13 approval — read-only browsing is free (ADR-0174 §2).
   */
  sideEffectful: boolean;
  /** True iff the tool loads a page (counts against the per-session page cap). */
  consumesPage: boolean;
  /** A one-line description (the human-readable receipt + the tool surface doc). */
  description: string;
}

/**
 * The tool surface. `click`/`type` are side-effectful by default — a click can submit a form, post,
 * or purchase, and typing can fill a form; both are conservatively gated rather than guessed safe.
 * Read-only browsing (navigate/read_page/screenshot/scroll/wait) never mutates and is free.
 */
export const BROWSER_TOOLS: readonly BrowserToolSpec[] = [
  { name: "navigate", sideEffectful: false, consumesPage: true, description: "Load a URL in the session browser" },
  { name: "read_page", sideEffectful: false, consumesPage: false, description: "Read the page text + accessibility tree" },
  { name: "screenshot", sideEffectful: false, consumesPage: false, description: "Capture a screenshot of the viewport" },
  { name: "scroll", sideEffectful: false, consumesPage: false, description: "Scroll the page" },
  { name: "wait", sideEffectful: false, consumesPage: false, description: "Wait for the page to settle" },
  { name: "click", sideEffectful: true, consumesPage: false, description: "Click an element (may mutate remote state — gated)" },
  { name: "type", sideEffectful: true, consumesPage: false, description: "Type into an element (may mutate remote state — gated)" },
];

const BY_NAME: ReadonlyMap<BrowserToolName, BrowserToolSpec> = new Map(
  BROWSER_TOOLS.map((t) => [t.name, t]),
);

export function isBrowserToolName(value: unknown): value is BrowserToolName {
  return typeof value === "string" && (BROWSER_TOOL_NAMES as readonly string[]).includes(value);
}

/** Look up a tool spec by name (throws on an unknown name — the surface is closed). */
export function browserToolSpec(name: BrowserToolName): BrowserToolSpec {
  const spec = BY_NAME.get(name);
  if (!spec) throw new Error(`unknown browser tool: ${String(name)}`);
  return spec;
}

/** True iff the tool mutates remote state (and therefore requires a #13 approval). */
export function isSideEffectful(name: BrowserToolName): boolean {
  return browserToolSpec(name).sideEffectful;
}

/** True iff the tool loads a page (counts against the per-session page cap). */
export function consumesPage(name: BrowserToolName): boolean {
  return browserToolSpec(name).consumesPage;
}
