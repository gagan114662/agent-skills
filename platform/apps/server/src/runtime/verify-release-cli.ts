/**
 * `node dist/runtime/verify-release-cli.js` (script: `pnpm --filter @reload/server verify:release`) — the
 * post-deploy gate that closes #292: probe the LIVE host's `/version` and assert it reports the commit we
 * just shipped. A mismatch (or an unreachable/old host) exits non-zero, turning the deploy job RED instead
 * of letting prod silently stay on the previous image while CI is green (the v80 blocker).
 *
 * It is the production-grounded, external receipt the premortem (#200) demands: this never trusts local
 * build state — it queries the real running service over the network and fails closed. The pure decision
 * lives in {@link decideReleaseAdvanced}; this file owns only the IO (fetch + retry) and the exit code, and
 * {@link verifyReleaseLive} takes the probe + sleep as injectable deps so a unit test pins the retry and
 * fail-closed behavior without a network.
 *
 * Config (env):
 *   RELEASE_EXPECTED_SHA   the commit that was deployed (CI passes ${{ github.sha }}). Required.
 *   RELEASE_VERIFY_URL     base URL of the live host (default https://reload-api.fly.dev).
 *   RELEASE_VERIFY_ATTEMPTS / RELEASE_VERIFY_DELAY_MS   retry budget for the routing edge to settle.
 */
import { decideReleaseAdvanced, normalizeSha, type ReleaseAdvanceVerdict } from "./release-verify.js";

export interface VerifyReleaseDeps {
  /** The commit we expect the live host to be running. */
  expectedSha: string;
  /** Fetch the live `/version` SHA. Returns the raw reported value, or `null` on any IO/parse failure. */
  probe: () => Promise<string | null>;
  /** How many times to probe before giving up (default 10). */
  attempts?: number;
  /** Delay between probes, ms (default 6000) — lets a rolling cutover + routing settle. */
  delayMs?: number;
  /** Injectable sleep so tests don't actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Secret-free progress sink (console.log by default). */
  log?: (line: string) => void;
}

/**
 * Probe the live host up to `attempts` times; succeed as soon as the reported SHA matches the deployed
 * commit, otherwise return the last (failing) verdict. Fail-closed: a probe that throws/returns null is
 * treated as "live SHA unknown" and retried, and the final verdict is `advanced: false`.
 */
export async function verifyReleaseLive(deps: VerifyReleaseDeps): Promise<ReleaseAdvanceVerdict> {
  const attempts = Math.max(1, deps.attempts ?? 10);
  const delayMs = deps.delayMs ?? 6000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? ((line: string) => console.log(line));

  let last: ReleaseAdvanceVerdict = decideReleaseAdvanced({ expectedSha: deps.expectedSha, liveSha: null });

  for (let i = 1; i <= attempts; i++) {
    let liveSha: string | null = null;
    try {
      liveSha = await deps.probe();
    } catch {
      liveSha = null; // fail closed — an errored probe is "unknown", never a pass.
    }
    last = decideReleaseAdvanced({ expectedSha: deps.expectedSha, liveSha });
    log(`[verify-release] attempt ${i}/${attempts}: ${last.reason}`);
    if (last.advanced) return last;
    if (i < attempts) await sleep(delayMs);
  }
  return last;
}

/** Real `/version` probe: fetch JSON, return the reported version string (or null on any failure). */
export async function fetchLiveVersion(baseUrl: string): Promise<string | null> {
  try {
    const res = await fetch(new URL("/version", baseUrl).toString(), {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) return null;
    const v = (body as { version?: unknown }).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

// Run as a CLI only when invoked directly (not when imported by tests).
const invokedPath = process.argv[1] ?? "";
if (invokedPath.endsWith("verify-release-cli.ts") || invokedPath.endsWith("verify-release-cli.js")) {
  const expectedRaw = process.env.RELEASE_EXPECTED_SHA ?? process.env.GITHUB_SHA ?? "";
  const baseUrl = process.env.RELEASE_VERIFY_URL ?? "https://reload-api.fly.dev";
  const attempts = Number(process.env.RELEASE_VERIFY_ATTEMPTS ?? "10");
  const delayMs = Number(process.env.RELEASE_VERIFY_DELAY_MS ?? "6000");

  if (!normalizeSha(expectedRaw)) {
    console.error(
      "[verify-release] RELEASE_EXPECTED_SHA is not a valid git SHA — cannot verify the release advanced. " +
        "In CI this is `${{ github.sha }}`.",
    );
    process.exit(1);
  }

  console.log(`[verify-release] verifying ${baseUrl}/version reports the deployed commit…`);
  verifyReleaseLive({
    expectedSha: expectedRaw,
    probe: () => fetchLiveVersion(baseUrl),
    attempts: Number.isFinite(attempts) ? attempts : 10,
    delayMs: Number.isFinite(delayMs) ? delayMs : 6000,
  })
    .then((verdict) => {
      if (!verdict.advanced) {
        console.error(`[verify-release] FAILED: ${verdict.reason}`);
        console.error(
          "[verify-release] The deploy did not put the new image into service. Capture the current release " +
            "as a rollback target and re-run `flyctl deploy -a reload-api` (or `workflow_dispatch` fly-deploy), " +
            "then re-verify. See ADR-0292.",
        );
        process.exit(1);
      }
      console.log(`[verify-release] OK: ${verdict.reason}`);
    })
    .catch((err: unknown) => {
      console.error("[verify-release] error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
