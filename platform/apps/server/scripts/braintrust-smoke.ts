/**
 * Send a single Braintrust span so the onboarding "waiting for first trace" check clears and you
 * can confirm the API key + project wiring end-to-end. Run from apps/server:
 *
 *   BRAINTRUST_API_KEY=<your key> pnpm trace:smoke
 *
 * (Or put BRAINTRUST_API_KEY in apps/server/.env first.) This is a one-off utility — the real
 * per-session tracing is wired into the SessionManager via runtime/default.ts.
 */
import { initLogger, traced } from "braintrust";

async function main(): Promise<void> {
  if (!process.env.BRAINTRUST_API_KEY) {
    console.error("BRAINTRUST_API_KEY is not set — export it (or add it to .env) and re-run.");
    process.exit(1);
  }
  const projectName = process.env.BRAINTRUST_PROJECT ?? "My Project";
  const logger = initLogger({ projectName });
  await traced(
    (span) => {
      span.log({
        input: "smoke test: hello from the reload platform",
        output: "ok",
        metadata: { source: "braintrust-smoke" },
      });
    },
    { name: "smoke_trace" },
  );
  await logger.flush();
  console.log(`Sent one trace to Braintrust project "${projectName}". Open the dashboard to see it.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
