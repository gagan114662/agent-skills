/**
 * Web↔API deploy-freshness / version-parity gate (#366) — a PURE, default-OFF, owner-workspace-first check
 * that makes a stale Vercel web bundle running against a newer (or older) `api.ipop.ai` *detectable* instead
 * of silent. It is the WEB half of the #292 version-advance discipline: #292 stamps the API image's git SHA
 * (`GIT_SHA` → `GET /version`) and verifies, post-deploy, that the LIVE host advanced to the deployed commit.
 * #366 adds the symmetric signal on the front end — the web bundle is stamped with its own build SHA
 * (`VITE_RELOAD_BUILD_SHA`, inlined by Vite at build time from Vercel's `VERCEL_GIT_COMMIT_SHA`), and the
 * console compares it against the API's reported `/version`. When they diverge (the preview-vs-prod /
 * stale-bundle confusion this epic kept hitting), the owner sees a banner rather than a board that silently
 * lags the code.
 *
 * Two invariants, both matching the backend's safest default (and the coordination #352 / connect-health
 * #365 web gates):
 *   · DEFAULT-OFF  — env unset ⇒ off ⇒ the banner renders for nobody, so prod (no env) is byte-for-byte the
 *                    board it is today.
 *   · OWNER-FIRST  — even when on, it shows ONLY for the named owner workspace; naming nobody (no owner id)
 *                    shows it to nobody (fail-closed).
 *
 * Verdict discipline (premortem #200, FM#2 + FM#6): {@link decideVersionParity} only ever raises a
 * "mismatch" when it holds TWO valid, genuinely-divergent SHAs. The API's `/version` body is untrusted
 * network DATA, so {@link normalizeSha} bounds it to plain hex (mirroring #292's `release-verify.ts`); an
 * empty/unstamped/garbage value on EITHER side normalizes to `null` → "unknown" → the banner stays SILENT.
 * A local/dev build (no stamp) therefore never false-alarms, and we never fabricate a freshness claim we
 * cannot ground.
 */

const env = import.meta.env;

/** Read a string env value, coercing away non-strings/empties. */
function readEnv(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * The git SHA Vite inlined into THIS bundle at build time. Vercel's build exposes the deployed commit as
 * `VERCEL_GIT_COMMIT_SHA`; the build command maps it to `VITE_RELOAD_BUILD_SHA` so Vite can statically
 * replace `import.meta.env.VITE_RELOAD_BUILD_SHA`. Unset for un-stamped local builds ⇒ "unknown" parity,
 * never a confirmed match/mismatch.
 */
export const WEB_BUILD_SHA: string | undefined = readEnv(env.VITE_RELOAD_BUILD_SHA);

/** Master switch — `VITE_RELOAD_VERSION_CHECK_UI=true|1`. Default OFF (any other / unset ⇒ off). */
export const VERSION_CHECK_UI_ENABLED: boolean = (() => {
  const raw = readEnv(env.VITE_RELOAD_VERSION_CHECK_UI);
  return raw === "true" || raw === "1";
})();

/** The owner's own workspace id (owner-first marker) — `VITE_RELOAD_VERSION_CHECK_OWNER_WORKSPACE_ID`. */
export const VERSION_CHECK_OWNER_WORKSPACE_ID: string | undefined = readEnv(
  env.VITE_RELOAD_VERSION_CHECK_OWNER_WORKSPACE_ID,
);

export interface VersionCheckGateInput {
  /** The master flag (default OFF). */
  readonly flagOn: boolean;
  /** The owner's workspace id (owner-first marker); empty/unset ⇒ nobody. */
  readonly ownerWorkspaceId?: string | null | undefined;
  /** The current workspace id. */
  readonly workspaceId?: string | null | undefined;
}

/**
 * Decide whether the version-parity banner shows. PURE so every branch is unit-tested without a DOM.
 * Fail-closed at every branch: off flag ⇒ no · no current workspace ⇒ no · no named owner ⇒ no (named
 * nobody = nobody) · otherwise show ONLY when the current workspace IS the named owner.
 */
export function shouldShowVersionCheck(input: VersionCheckGateInput): boolean {
  if (!input.flagOn) return false;
  const ws = input.workspaceId?.trim();
  if (!ws) return false;
  const owner = input.ownerWorkspaceId?.trim();
  if (!owner) return false;
  return ws === owner;
}

/**
 * A git object SHA: 7–64 lowercase hex chars (mirrors #292 `release-verify.ts`). The bound is the injection
 * guard — a `/version` response that isn't a plain short hex string can never masquerade as a version.
 */
const SHA_RE = /^[0-9a-f]{7,64}$/;

/**
 * Coerce an untrusted value into a canonical git SHA, or `null` when it is not one. Trims and lower-cases
 * before validating, so `"  ABC1234\n"` ⇒ `"abc1234"`.
 */
export function normalizeSha(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  return SHA_RE.test(s) ? s : null;
}

/** Tri-state outcome of comparing the web bundle's SHA against the API's reported `/version`. */
export type VersionParityStatus = "match" | "mismatch" | "unknown";

export interface VersionParityVerdict {
  /**
   * `match` — both valid and same commit · `mismatch` — both valid and divergent (the stale-bundle signal,
   * the ONLY state that raises the banner) · `unknown` — either side missing/malformed (silent, no claim).
   */
  status: VersionParityStatus;
  /** Secret-free, human-readable outcome line. */
  reason: string;
  /** The normalized web build SHA, or `null` when missing/malformed. */
  web: string | null;
  /** The normalized API `/version` SHA, or `null` when missing/malformed. */
  api: string | null;
}

/**
 * Decide web↔API parity. Pure and fail-closed (premortem #200, FM#2):
 *  - a missing/malformed SHA on EITHER side → `unknown` (we never claim a (mis)match we can't ground; an
 *    unstamped local build or an old/unstamped API host stays silent rather than false-alarming);
 *  - otherwise `match` IFF one SHA is a prefix of the other (either side may be abbreviated), else
 *    `mismatch` — the stale-bundle / preview-vs-prod divergence #366 makes visible.
 */
export function decideVersionParity(input: { webSha: unknown; apiSha: unknown }): VersionParityVerdict {
  const web = normalizeSha(input.webSha);
  const api = normalizeSha(input.apiSha);

  if (!web || !api) {
    return {
      status: "unknown",
      reason: !web
        ? "this web build was not stamped with a commit SHA (local/dev build) — parity is unknown, staying silent."
        : "the API reported no usable build SHA (an old/unstamped host, or /version unreachable) — parity is unknown.",
      web,
      api,
    };
  }

  const same = web.startsWith(api) || api.startsWith(web);
  return same
    ? { status: "match", reason: `web and API are on the same commit (${web}).`, web, api }
    : {
        status: "mismatch",
        reason:
          `the web bundle is on ${web} but the API is on ${api} — they are NOT the same build. ` +
          `The board you see may lag (or lead) the running API; redeploy the stale side. See ADR-0366.`,
        web,
        api,
      };
}
