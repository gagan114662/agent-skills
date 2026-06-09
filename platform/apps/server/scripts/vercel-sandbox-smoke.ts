/**
 * Vercel Sandbox smoke test (#25) — proves the `sandbox` backend end-to-end against real Vercel,
 * mirroring Conductor's Cloud Workspaces flow described in
 * https://vercel.com/blog/how-conductor-moved-parallel-coding-agents-from-the-laptop-to-the-cloud-with-vercel-sandbox:
 *
 *   provision a microVM (optionally cloning a repo at a branch)
 *     -> run a command with live, streamed output
 *       -> snapshot for fast resume
 *         -> stop (reap)
 *
 * This is the one path that cannot run in CI (it makes real, billable cloud calls), so it lives as
 * an opt-in script you run by hand with your own credentials.
 *
 * Run:
 *   pnpm --filter @reload/server add @vercel/sandbox      # one-time: install the optional SDK
 *   AGENT_RUNTIME=sandbox \
 *   VERCEL_TOKEN=...  VERCEL_TEAM_ID=...  VERCEL_PROJECT_ID=... \
 *   pnpm --filter @reload/server sandbox:smoke
 *
 * Put the token in a local, gitignored .env — NEVER commit it.
 */
import { loadEnv } from "../src/env.js";
import { VercelSandboxProvider } from "../src/runtime/vercel-provider.js";

async function main(): Promise<void> {
  // Fail loudly BEFORE any cloud call if auth isn't configured.
  const missing = ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"].filter(
    (k) => !process.env[k],
  );
  if (missing.length) {
    throw new Error(
      `Missing ${missing.join(", ")}. See .env.example. Aborting before any Vercel call.`,
    );
  }

  const caps = loadEnv().agent.caps;
  const repoUrl = process.env.SANDBOX_REPO_URL?.trim();
  const provider = new VercelSandboxProvider();

  console.log(
    repoUrl
      ? `[smoke] provisioning a Vercel Sandbox and cloning ${repoUrl} ...`
      : "[smoke] provisioning an empty Vercel Sandbox ...",
  );

  const sandbox = await provider.create({
    sessionId: "smoke",
    workspaceId: "smoke",
    env: { GREETING: "hello-from-vercel-sandbox" },
    secrets: {},
    caps,
    source: repoUrl
      ? { url: repoUrl, revision: process.env.SANDBOX_REPO_REVISION?.trim() || undefined }
      : undefined,
  });
  console.log(`[smoke] sandbox up: ${sandbox.id}`);

  // Stream output live, exactly as the SessionManager does in production.
  const script = repoUrl
    ? 'echo "repo contents:"; ls -la; echo "HEAD:"; git log -1 --oneline || true'
    : 'echo "$GREETING"; uname -a; node --version';
  const { exitCode } = await sandbox.run("bash", ["-lc", script], (stream, chunk) => {
    (stream === "stderr" ? process.stderr : process.stdout).write(chunk);
  });
  console.log(`\n[smoke] command exited with code ${exitCode}`);

  // Snapshot for fast resume (auto-stops the VM); fall back to an explicit stop if unsupported.
  try {
    const snapshotId = await sandbox.snapshot();
    console.log(`[smoke] snapshot captured: ${snapshotId}`);
  } catch (err) {
    console.warn(`[smoke] snapshot skipped (${(err as Error).message}); stopping sandbox`);
    await sandbox.stop();
  }

  console.log("[smoke] done ✔");
}

main().catch((err) => {
  console.error("[smoke] failed:", err);
  process.exitCode = 1;
});
