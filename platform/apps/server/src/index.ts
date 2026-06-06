import { buildApp } from "./app.js";
import { loadEnv } from "./env.js";
import { closeDb } from "./db/index.js";
import { closeRedis } from "./redis/index.js";

const env = loadEnv();
const app = buildApp();

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down");
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
