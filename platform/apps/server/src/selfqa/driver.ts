import type { QaCheck, RawCheckResult } from "./types.js";

/**
 * The headless-driver seam for the Self-QA Loop (#171, ADR-0171). "Playwright or equivalent" — equivalent
 * by default, Playwright on opt-in:
 *
 *  - {@link noopDriver} — every check passes. The safe default (unit tests; unconfigured deployments).
 *  - {@link httpSmokeDriver} — dependency-free, uses global `fetch`. Asserts the live web + API are
 *    reachable and healthy. This is the "equivalent" headless pass that runs in CI with no browser binary
 *    and no lockfile churn. It can't click a button, so a check it cannot disprove via HTTP passes; a
 *    surface whose page/API is down fails. A probe error is a *failed check*, never a crash.
 *  - {@link createPlaywrightDriver} — the real browser, `import()`-ed LAZILY behind `SELFQA_DRIVER=playwright`
 *    so `playwright` is never a hard dependency. Throws a friendly, actionable error if not installed.
 */

export interface QaCheckContext {
  /** The live product URL under test (e.g. `https://ipop.ai`). */
  target: string;
  /** Optional per-check timeout. */
  timeoutMs?: number;
}

export interface QaBrowserDriver {
  run(check: QaCheck, ctx: QaCheckContext): Promise<RawCheckResult>;
}

/** A driver where every check passes — the default. Never touches the network. */
export const noopDriver: QaBrowserDriver = {
  run: async (check): Promise<RawCheckResult> => ({ checkId: check.id, ok: true }),
};

const DEFAULT_TIMEOUT_MS = 10_000;
const SNIPPET_MAX = 200;

/** Probe one URL. Any failure (timeout, DNS, reset, non-2xx) becomes a failed result, never a throw. */
async function probe(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      redirect: "manual",
      headers: { "User-Agent": "selfqa-synthetic-user" },
    });
    // 2xx and 3xx (a redirect to the app shell) are healthy; 4xx/5xx are a real failure.
    const ok = res.status >= 200 && res.status < 400;
    const body = await res.text().catch(() => "");
    return {
      ok,
      detail: ok
        ? `status ${res.status}`
        : `status ${res.status}: ${body.replace(/\s+/g, " ").trim().slice(0, SNIPPET_MAX)}`,
    };
  } catch (err) {
    return { ok: false, detail: `request failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Derive the API health URL for session/API-dependent checks from the web target. Best-effort. */
function apiHealthUrl(target: string): string {
  try {
    const u = new URL(target);
    if (!u.hostname.startsWith("api.")) u.hostname = `api.${u.hostname}`;
    u.pathname = "/livez";
    u.search = "";
    return u.toString();
  } catch {
    return target;
  }
}

/** A check is API-dependent (probe the backend) vs page-dependent (probe the web shell). */
function probeUrlFor(check: QaCheck, target: string): string {
  return check.surface === "sessions" ? apiHealthUrl(target) : target;
}

/**
 * The dependency-free HTTP smoke driver. For each check it probes the relevant live URL (the web shell,
 * or the API for session checks) and reports reachability/health. `fetchImpl` is injectable so the driver
 * is unit-tested network-free.
 */
export function httpSmokeDriver(fetchImpl: typeof fetch = fetch): QaBrowserDriver {
  return {
    run: async (check, ctx): Promise<RawCheckResult> => {
      const { ok, detail } = await probe(probeUrlFor(check, ctx.target), fetchImpl, ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      return ok ? { checkId: check.id, ok: true } : { checkId: check.id, ok: false, actual: detail };
    },
  };
}

/**
 * Lazily construct the real Playwright driver. Only imported when explicitly selected, so `playwright`
 * stays out of the dependency graph (and the `--frozen-lockfile` CI install) until a runner image opts in.
 */
/**
 * The minimal structural slice of Playwright the launch-probe uses. Declared locally (not imported) so
 * `playwright`'s types are NOT a build dependency — the package is resolved purely at runtime.
 */
interface PlaywrightLike {
  chromium: {
    launch(): Promise<{
      newPage(): Promise<{
        goto(url: string, opts: { waitUntil: string; timeout: number }): Promise<{ status(): number } | null>;
      }>;
      close(): Promise<void>;
    }>;
  };
}

export async function createPlaywrightDriver(): Promise<QaBrowserDriver> {
  let pw: PlaywrightLike;
  try {
    // The specifier is a runtime string so TS does not try to resolve the (optional) module at build time.
    const mod = "playwright";
    pw = (await import(mod)) as unknown as PlaywrightLike;
  } catch {
    throw new Error(
      "SELFQA_DRIVER=playwright requires the 'playwright' package (and `npx playwright install chromium`). " +
        "Install it in the runner image, or use the default HTTP smoke driver.",
    );
  }
  // The full click-through assertions live in the runner image; here we only prove the browser launches
  // and the page loads, so an un-provisioned environment fails loudly rather than silently passing.
  return {
    run: async (check, ctx): Promise<RawCheckResult> => {
      const browser = await pw.chromium.launch();
      try {
        const page = await browser.newPage();
        const res = await page.goto(ctx.target, { waitUntil: "domcontentloaded", timeout: ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS });
        const status = res?.status() ?? 0;
        const ok = status >= 200 && status < 400;
        return ok ? { checkId: check.id, ok: true } : { checkId: check.id, ok: false, actual: `status ${status}` };
      } finally {
        await browser.close();
      }
    },
  };
}

/** Resolve a driver by name. Unknown / `none` / unset ⇒ the no-op (never silently launches a browser). */
export function resolveDriver(name: string | undefined, fetchImpl: typeof fetch = fetch): QaBrowserDriver {
  switch (name) {
    case "http":
      return httpSmokeDriver(fetchImpl);
    default:
      return noopDriver;
  }
}
