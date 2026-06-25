export const DEFAULT_WORKSPACE_LOOP_CONCURRENCY = 4;

export function clampLoopConcurrency(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_WORKSPACE_LOOP_CONCURRENCY;
  return Math.max(1, Math.floor(value!));
}

export async function runBounded<T>(
  items: readonly T[],
  concurrency: number | undefined,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const limit = clampLoopConcurrency(concurrency);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await worker(items[index]!, index);
    }
  });
  await Promise.all(workers);
}
