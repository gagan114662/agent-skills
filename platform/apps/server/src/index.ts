import { buildApp } from "./app.js";
import { loadEnv } from "./env.js";
import { closeDb } from "./db/index.js";
import { closeRedis } from "./redis/index.js";

const env = loadEnv();
const app = buildApp();

// #17 autonomy: start the opt-in background loop (AUTONOMY_INTERVAL_MS; default 0 = off). The
// engine is stopped on server close via the onClose hook registered in buildApp.
app.autonomyEngine.start(env.autonomy.intervalMs);

// #55 cloud workspaces: opt-in idle sweep (CLOUD_SWEEP_INTERVAL_MS; default 0 = off) that sleeps
// workspaces idle longer than CLOUD_IDLE_MS to save resources. Tests drive sweepIdle() directly.
let sweepTimer: NodeJS.Timeout | undefined;
if (env.cloud.sweepIntervalMs > 0) {
  sweepTimer = setInterval(() => {
    const idleBefore = new Date(Date.now() - env.cloud.idleMs);
    app.cloudWorkspaceManager
      .sweepIdle(idleBefore)
      .catch((err) => app.log.error({ err }, "cloud workspace idle sweep failed"));
  }, env.cloud.sweepIntervalMs);
  sweepTimer.unref();
}

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down");
  if (sweepTimer) clearInterval(sweepTimer);
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void shutdown(signal));
}

app
  .listen({ port: env.port, host: "0.0.0.0" })
  .then((address) => app.log.info(`Reload server listening on ${address}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
