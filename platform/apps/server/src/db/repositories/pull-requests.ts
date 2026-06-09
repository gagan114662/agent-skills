import { and, desc, eq } from "drizzle-orm";
import type { ChecksStatus, PullRequestDto, PullRequestState } from "@reload/shared";
import { db } from "../index.js";
import { pullRequests } from "../schema/index.js";

const COLUMNS = {
  id: pullRequests.id,
  workspaceId: pullRequests.workspaceId,
  channelId: pullRequests.channelId,
  sessionId: pullRequests.sessionId,
  number: pullRequests.number,
  url: pullRequests.url,
  title: pullRequests.title,
  body: pullRequests.body,
  draft: pullRequests.draft,
  state: pullRequests.state,
  checksStatus: pullRequests.checksStatus,
  baseBranch: pullRequests.baseBranch,
  headBranch: pullRequests.headBranch,
  provider: pullRequests.provider,
  createdByMemberId: pullRequests.createdByMemberId,
  createdAt: pullRequests.createdAt,
  updatedAt: pullRequests.updatedAt,
} as const;

/** A persisted PR row (Date fields); map to {@link PullRequestDto} for the wire via {@link toPrDto}. */
export interface PullRequestRow {
  id: string;
  workspaceId: string;
  channelId: string;
  sessionId: string | null;
  number: number | null;
  url: string | null;
  title: string;
  body: string | null;
  draft: boolean;
  state: PullRequestState;
  checksStatus: ChecksStatus;
  baseBranch: string;
  headBranch: string;
  provider: "none" | "gh";
  createdByMemberId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Serialize a row to its wire DTO (dates → ISO-8601). */
export function toPrDto(row: PullRequestRow): PullRequestDto {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function createPullRequest(input: {
  workspaceId: string;
  channelId: string;
  sessionId: string | null;
  number: number | null;
  url: string | null;
  title: string;
  body: string | null;
  draft: boolean;
  state: PullRequestState;
  baseBranch: string;
  headBranch: string;
  provider: "none" | "gh";
  createdByMemberId: string;
}): Promise<PullRequestRow> {
  const [row] = await db.insert(pullRequests).values(input).returning(COLUMNS);
  return row as PullRequestRow;
}

/** Update a PR's checks rollup + bump `updatedAt`. Scoped to the channel (IDOR-safe). */
export async function updatePrChecks(
  id: string,
  channelId: string,
  checksStatus: ChecksStatus,
): Promise<void> {
  await db
    .update(pullRequests)
    .set({ checksStatus, updatedAt: new Date() })
    .where(and(eq(pullRequests.id, id), eq(pullRequests.channelId, channelId)));
}

/** Fetch one PR scoped to its channel (prevents cross-channel/tenant reads). */
export async function getPullRequest(
  id: string,
  channelId: string,
): Promise<PullRequestRow | undefined> {
  const [row] = await db
    .select(COLUMNS)
    .from(pullRequests)
    .where(and(eq(pullRequests.id, id), eq(pullRequests.channelId, channelId)))
    .limit(1);
  return row as PullRequestRow | undefined;
}

/** PRs for a channel, newest first. */
export async function listPullRequests(channelId: string): Promise<PullRequestRow[]> {
  const rows = await db
    .select(COLUMNS)
    .from(pullRequests)
    .where(eq(pullRequests.channelId, channelId))
    .orderBy(desc(pullRequests.createdAt));
  return rows as PullRequestRow[];
}
