/**
 * The browser driver seam (#174, ADR-0174). A thin, structural interface over "a real Chromium" so the
 * session logic is unit-tested with a {@link createFakeBrowserDriver fake} and the real engine is a
 * lazily-imported Playwright (mirroring the #171 self-QA driver: the specifier is a runtime string so
 * `playwright` is NEVER a build/lockfile dependency, and an un-provisioned image throws loudly rather
 * than silently passing). The platform only depends on these interfaces — Playwright's own types are
 * declared structurally below, so the package stays out of the dependency graph until a runtime image
 * opts in (`npx playwright install chromium`).
 *
 * Isolation is the contract: `newContext` returns ONE fresh, profile-isolated context per session — no
 * shared cookies, no shared storage — so {@link BrowserSessionManager} can hand each session a context
 * that is torn down with the session and never bleeds state across tenants.
 */
import type { BrowserToolName } from "./tools.js";

/** The result of a navigation: the HTTP status, the bytes transferred (for the bandwidth cap), final URL. */
export interface BrowserNavResult {
  status: number;
  bytes: number;
  url: string;
}

/** A read of the current page: the URL, title, and the rendered text + accessibility tree. */
export interface BrowserPageSnapshot {
  url: string;
  title: string;
  /** The page text (and, where available, a flattened accessibility tree) the agent reads. */
  text: string;
}

/** A captured screenshot: the raw byte count and a base64 image (stored as a receipt attachment). */
export interface BrowserScreenshot {
  bytes: number;
  base64: string;
}

/** Scroll intent — to a named edge or by a pixel delta. */
export interface BrowserScrollOptions {
  to?: "top" | "bottom";
  deltaY?: number;
}

/** One page inside a session's isolated context. Methods map 1:1 onto Playwright's `Page`. */
export interface BrowserPageHandle {
  goto(url: string): Promise<BrowserNavResult>;
  snapshot(): Promise<BrowserPageSnapshot>;
  screenshot(): Promise<BrowserScreenshot>;
  click(selector: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  scroll(options?: BrowserScrollOptions): Promise<void>;
  /** The current page URL (for a per-action denylist re-check; never throws). */
  url(): string;
}

/** A session-isolated browser context (one per session). Closing it frees the profile + all pages. */
export interface BrowserContextHandle {
  newPage(): Promise<BrowserPageHandle>;
  close(): Promise<void>;
}

export interface BrowserDriver {
  /** Allocate a fresh, profile-isolated context (no shared cookies/storage) for one session. */
  newContext(opts: { sessionId: string; workspaceId: string }): Promise<BrowserContextHandle>;
}

// ---- the lazily-imported real Playwright driver -------------------------------------------------

/**
 * The minimal structural slice of Playwright used here. Declared locally (not imported) so Playwright's
 * types are NOT a build dependency — the package is resolved purely at runtime, like #171's driver.
 */
interface PlaywrightLike {
  chromium: {
    launch(opts?: { headless?: boolean }): Promise<PwBrowser>;
  };
}
interface PwBrowser {
  newContext(): Promise<PwContext>;
  close(): Promise<void>;
}
interface PwContext {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwResponse {
  status(): number;
  body(): Promise<{ length: number }>;
}
interface PwPage {
  goto(url: string, opts: { waitUntil: string; timeout: number }): Promise<PwResponse | null>;
  title(): Promise<string>;
  innerText(selector: string): Promise<string>;
  url(): string;
  screenshot(): Promise<{ length: number; toString(enc: string): string }>;
  click(selector: string, opts: { timeout: number }): Promise<void>;
  fill(selector: string, text: string, opts: { timeout: number }): Promise<void>;
  evaluate(fn: string): Promise<unknown>;
}

const DEFAULT_NAV_TIMEOUT_MS = 30_000;
const DEFAULT_ACTION_TIMEOUT_MS = 10_000;

/**
 * Construct the real Playwright-backed driver. `playwright` is imported lazily so it never enters the
 * build/lockfile until a runtime image installs it; a missing package throws an actionable error. One
 * Chromium is launched and shared, but every session gets its OWN `browser.newContext()` (the isolation
 * boundary). The launched browser is returned via the closeable so the manager can shut it down.
 */
export async function createPlaywrightDriver(): Promise<BrowserDriver & { shutdown(): Promise<void> }> {
  let pw: PlaywrightLike;
  try {
    // Runtime-string specifier so TS does not resolve the optional module at build time.
    const mod = "playwright";
    pw = (await import(mod)) as unknown as PlaywrightLike;
  } catch {
    throw new Error(
      "the agent browser runtime requires the 'playwright' package (and `npx playwright install chromium`). " +
        "Install it in the runtime image, or keep RELOAD_AGENT_BROWSER_ENABLED off.",
    );
  }
  const browser = await pw.chromium.launch({ headless: true });
  return {
    async newContext(): Promise<BrowserContextHandle> {
      const ctx = await browser.newContext();
      return {
        async newPage(): Promise<BrowserPageHandle> {
          const page = await ctx.newPage();
          return wrapPlaywrightPage(page);
        },
        close: () => ctx.close(),
      };
    },
    shutdown: () => browser.close(),
  };
}

function wrapPlaywrightPage(page: PwPage): BrowserPageHandle {
  return {
    async goto(url): Promise<BrowserNavResult> {
      const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_NAV_TIMEOUT_MS });
      const status = res?.status() ?? 0;
      let bytes = 0;
      try {
        bytes = res ? (await res.body()).length : 0;
      } catch {
        bytes = 0; // some responses (redirects, no-body) have no readable body
      }
      return { status, bytes, url: page.url() };
    },
    async snapshot(): Promise<BrowserPageSnapshot> {
      const [title, text] = await Promise.all([
        page.title().catch(() => ""),
        page.innerText("body").catch(() => ""),
      ]);
      return { url: page.url(), title, text };
    },
    async screenshot(): Promise<BrowserScreenshot> {
      const buf = await page.screenshot();
      return { bytes: buf.length, base64: buf.toString("base64") };
    },
    click: (selector) => page.click(selector, { timeout: DEFAULT_ACTION_TIMEOUT_MS }),
    type: (selector, text) => page.fill(selector, text, { timeout: DEFAULT_ACTION_TIMEOUT_MS }),
    async scroll(options): Promise<void> {
      const delta = options?.to === "bottom" ? 1e7 : options?.to === "top" ? -1e7 : options?.deltaY ?? 600;
      await page.evaluate(`window.scrollBy(0, ${Number(delta)})`);
    },
    url: () => page.url(),
  };
}

// ---- the fake driver used by the unit job -------------------------------------------------------

/** A fake page that records every call + a per-context cookie jar so isolation can be asserted. */
export interface FakeBrowserPage extends BrowserPageHandle {
  readonly calls: string[];
}

/** A fake context exposing its cookie jar + closed flag so tests can prove per-session isolation. */
export interface FakeBrowserContext extends BrowserContextHandle {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly cookies: Map<string, string>;
  closed: boolean;
  setCookie(name: string, value: string): void;
}

/** A fake driver that hands out independent contexts + records them, for the unit job. */
export interface FakeBrowserDriver extends BrowserDriver {
  readonly contexts: FakeBrowserContext[];
}

/**
 * Build a fake driver. Each `newContext` yields a brand-new, independent context with its own cookie
 * jar (so a cookie set in one is invisible in another — the isolation guarantee). Navigations return a
 * deterministic 200 with a fixed byte count so the caps/bandwidth logic is exercised without a network.
 */
export function createFakeBrowserDriver(opts?: {
  navBytes?: number;
  screenshotBytes?: number;
  status?: number;
  /** Tool actions whose page method should throw (to exercise the session's failure path). */
  failTools?: BrowserToolName[];
  /** When true, `newPage` throws AFTER the context is created (to exercise the manager's leak guard). */
  failNewPage?: boolean;
}): FakeBrowserDriver {
  const navBytes = opts?.navBytes ?? 100;
  const screenshotBytes = opts?.screenshotBytes ?? 50;
  const status = opts?.status ?? 200;
  const fail = new Set<BrowserToolName>(opts?.failTools ?? []);
  const contexts: FakeBrowserContext[] = [];

  return {
    contexts,
    async newContext(o): Promise<FakeBrowserContext> {
      const cookies = new Map<string, string>();
      let currentUrl = "about:blank";
      const page: FakeBrowserPage = {
        calls: [],
        async goto(url): Promise<BrowserNavResult> {
          this.calls.push(`goto:${url}`);
          if (fail.has("navigate")) throw new Error("fake navigate failure");
          currentUrl = url;
          return { status, bytes: navBytes, url };
        },
        async snapshot(): Promise<BrowserPageSnapshot> {
          this.calls.push("snapshot");
          if (fail.has("read_page")) throw new Error("fake read_page failure");
          return { url: currentUrl, title: `Fake ${currentUrl}`, text: `body text of ${currentUrl}` };
        },
        async screenshot(): Promise<BrowserScreenshot> {
          this.calls.push("screenshot");
          return { bytes: screenshotBytes, base64: "ZmFrZQ==" };
        },
        async click(selector): Promise<void> {
          this.calls.push(`click:${selector}`);
          if (fail.has("click")) throw new Error("fake click failure");
        },
        async type(selector, text): Promise<void> {
          this.calls.push(`type:${selector}=${text}`);
          if (fail.has("type")) throw new Error("fake type failure");
        },
        async scroll(options): Promise<void> {
          this.calls.push(`scroll:${options?.to ?? options?.deltaY ?? "default"}`);
        },
        url: () => currentUrl,
      };
      const ctx: FakeBrowserContext = {
        sessionId: o.sessionId,
        workspaceId: o.workspaceId,
        cookies,
        closed: false,
        setCookie: (name, value) => cookies.set(name, value),
        async newPage(): Promise<BrowserPageHandle> {
          if (opts?.failNewPage) throw new Error("fake newPage failure");
          return page;
        },
        async close(): Promise<void> {
          ctx.closed = true;
        },
      };
      contexts.push(ctx);
      return ctx;
    },
  };
}
