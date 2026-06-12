/**
 * `node dist/runtime/smoke-cli.js` — the post-deploy demo-harness smoke (#166 follow-up).
 *
 * Wired as the Fly `[deploy] release_command`: it runs on a one-off machine booted from the NEW image
 * before traffic shifts, and a non-zero exit aborts the rollout — so an image that cannot spawn a
 * session (e.g. missing `bash`, the #166 regression) never reaches production. No DB, no model spend.
 */
import { runDemoSmoke } from "./smoke-demo.js";

async function main(): Promise<void> {
  const res = await runDemoSmoke();
  // The demo harness emits only non-secret text (and masks DEMO_SECRET itself), so this is safe to log.
  console.log(`[smoke] ${res.reason}`);
  if (!res.ok) {
    console.error(
      `[smoke] FAILED — status=${res.status} exit=${res.exitCode} sawMarker=${res.sawMarker}. ` +
        `Aborting deploy: the image cannot run an agent session end-to-end.`,
    );
    process.exit(1);
  }
  console.log("[smoke] OK — a real demo-harness session spawned and completed.");
}

main().catch((err: unknown) => {
  console.error("[smoke] error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
