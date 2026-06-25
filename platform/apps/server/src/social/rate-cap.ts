import type { SocialNetwork } from "./decide.js";
import type { SocialPostRecord, SocialPostResultRecord } from "./store.js";

export interface SocialRateCaps {
  workspaceWindowMs: number;
  workspaceCap: number;
  networkWindowMs: number;
  networkCap: number;
  warmupDays: number;
  warmupStartCap: number;
  warmupDailyIncrement: number;
}

export const SOCIAL_RATE_CAP_DEFAULTS: SocialRateCaps = {
  workspaceWindowMs: 60 * 60 * 1000,
  workspaceCap: 10,
  networkWindowMs: 60 * 60 * 1000,
  networkCap: 5,
  warmupDays: 7,
  warmupStartCap: 3,
  warmupDailyIncrement: 2,
};

export interface SocialRateCapInput {
  networks: readonly SocialNetwork[];
  recentReceipts: readonly SocialPostResultRecord[];
  posts: readonly SocialPostRecord[];
  caps?: Partial<SocialRateCaps>;
  now: Date;
}

export interface SocialRateCapDecision {
  allowed: boolean;
  reason: string;
  workspaceInWindow: number;
  warmupSentToday: number;
  warmupCapToday: number;
  perNetworkInWindow: Partial<Record<SocialNetwork, number>>;
}

function resolveCaps(input?: Partial<SocialRateCaps>): SocialRateCaps {
  return {
    workspaceWindowMs: input?.workspaceWindowMs ?? SOCIAL_RATE_CAP_DEFAULTS.workspaceWindowMs,
    workspaceCap: input?.workspaceCap ?? SOCIAL_RATE_CAP_DEFAULTS.workspaceCap,
    networkWindowMs: input?.networkWindowMs ?? SOCIAL_RATE_CAP_DEFAULTS.networkWindowMs,
    networkCap: input?.networkCap ?? SOCIAL_RATE_CAP_DEFAULTS.networkCap,
    warmupDays: input?.warmupDays ?? SOCIAL_RATE_CAP_DEFAULTS.warmupDays,
    warmupStartCap: input?.warmupStartCap ?? SOCIAL_RATE_CAP_DEFAULTS.warmupStartCap,
    warmupDailyIncrement:
      input?.warmupDailyIncrement ?? SOCIAL_RATE_CAP_DEFAULTS.warmupDailyIncrement,
  };
}

function isSendLike(r: SocialPostResultRecord): boolean {
  return r.status === "published" || r.status === "scheduled";
}

function startOfUtcDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function firstActivityMs(
  posts: readonly SocialPostRecord[],
  receipts: readonly SocialPostResultRecord[],
  nowMs: number,
): number {
  const times = [
    ...posts.map((p) => Date.parse(p.createdAt)).filter(Number.isFinite),
    ...receipts.map((r) => Date.parse(r.recordedAt)).filter(Number.isFinite),
  ];
  return times.length > 0 ? Math.min(...times) : nowMs;
}

export function decideSocialRateCap(input: SocialRateCapInput): SocialRateCapDecision {
  const caps = resolveCaps(input.caps);
  const nowMs = input.now.getTime();
  const requested = input.networks.length;
  const sent = input.recentReceipts.filter(isSendLike);
  const workspaceCutoff = nowMs - caps.workspaceWindowMs;
  const workspaceInWindow = sent.filter((r) => Date.parse(r.recordedAt) >= workspaceCutoff).length;
  const perNetworkInWindow: Partial<Record<SocialNetwork, number>> = {};

  for (const network of input.networks) {
    const networkCutoff = nowMs - caps.networkWindowMs;
    perNetworkInWindow[network] = sent.filter(
      (r) => r.network === network && Date.parse(r.recordedAt) >= networkCutoff,
    ).length;
  }

  const firstMs = firstActivityMs(input.posts, input.recentReceipts, nowMs);
  const warmupDay = Math.max(
    0,
    Math.floor((startOfUtcDay(input.now) - startOfUtcDay(new Date(firstMs))) / 86_400_000),
  );
  const warmupCapToday =
    warmupDay >= caps.warmupDays
      ? Number.POSITIVE_INFINITY
      : caps.warmupStartCap + warmupDay * caps.warmupDailyIncrement;
  const todayStart = startOfUtcDay(input.now);
  const warmupSentToday = sent.filter((r) => Date.parse(r.recordedAt) >= todayStart).length;

  if (caps.workspaceCap <= 0 || workspaceInWindow + requested > caps.workspaceCap) {
    return {
      allowed: false,
      reason: `workspace social cap exceeded: ${workspaceInWindow}+${requested}/${caps.workspaceCap} per window`,
      workspaceInWindow,
      warmupSentToday,
      warmupCapToday,
      perNetworkInWindow,
    };
  }

  for (const network of input.networks) {
    const count = perNetworkInWindow[network] ?? 0;
    if (caps.networkCap <= 0 || count + 1 > caps.networkCap) {
      return {
        allowed: false,
        reason: `${network} social cap exceeded: ${count}+1/${caps.networkCap} per window`,
        workspaceInWindow,
        warmupSentToday,
        warmupCapToday,
        perNetworkInWindow,
      };
    }
  }

  if (warmupSentToday + requested > warmupCapToday) {
    return {
      allowed: false,
      reason: `social warmup cap exceeded: day ${warmupDay} allows ${warmupCapToday}, requested ${warmupSentToday}+${requested}`,
      workspaceInWindow,
      warmupSentToday,
      warmupCapToday,
      perNetworkInWindow,
    };
  }

  return {
    allowed: true,
    reason: `within social caps (${workspaceInWindow}+${requested}/${caps.workspaceCap} workspace window)`,
    workspaceInWindow,
    warmupSentToday,
    warmupCapToday,
    perNetworkInWindow,
  };
}
