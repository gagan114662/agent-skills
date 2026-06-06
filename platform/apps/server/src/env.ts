/** Environment configuration with local-dev defaults matching docker-compose.yml. */
export interface Env {
  port: number;
  databaseUrl: string;
  redisUrl: string;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return {
    port: Number(source.PORT ?? 3000),
    databaseUrl: source.DATABASE_URL ?? "postgres://reload:reload@localhost:5433/reload",
    redisUrl: source.REDIS_URL ?? "redis://localhost:6379",
  };
}
