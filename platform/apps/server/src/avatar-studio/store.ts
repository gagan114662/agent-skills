/**
 * Persistence seam for the AI UGC avatar studio (issue #741). Narrow interface the service consumes: append a
 * rendered avatar, read one back by its stable `avatarId`, and list a workspace's studio. The production binding
 * is the self-managed Postgres store in `default.ts`; unit tests inject {@link InMemoryAvatarStudioStore}, so the
 * service is tested with no database (the proven pure-core + injected-seam pattern).
 *
 * Persisting the FIRST render per `avatarId` is what guarantees persona consistency even across a non-deterministic
 * live provider: the service returns the stored config on every subsequent render of the same avatar. Everything
 * is workspace-scoped (the `workspaceId` is the first argument / a column on every row) so a caller can only ever
 * read its own tenant's studio — the #3 IDOR boundary.
 */

import type { AvatarConfig } from "./types.js";

/** A persisted rendered avatar. */
export interface StoredAvatar {
  id: string;
  workspaceId: string;
  avatarId: string;
  displayName: string;
  config: AvatarConfig;
  /** Which provider produced this config (`"fake"` or a live provider name). */
  provider: string;
  /** The member/agent on whose behalf the render ran. */
  requestedByMemberId: string | null;
  createdAt: Date;
}

export interface CreateAvatarInput {
  workspaceId: string;
  avatarId: string;
  displayName: string;
  config: AvatarConfig;
  provider: string;
  requestedByMemberId: string | null;
  createdAt: Date;
}

export interface AvatarStudioStore {
  /**
   * Append a rendered avatar, idempotent on (`workspaceId`, `avatarId`): if one already exists it is returned
   * UNCHANGED (persona consistency — the first render wins). Returns the stored row.
   */
  create(input: CreateAvatarInput): Promise<StoredAvatar>;
  /** Load one avatar by its stable id within a workspace (#3 IDOR scoping). Null when absent ("missing avatar"). */
  getByAvatarId(workspaceId: string, avatarId: string): Promise<StoredAvatar | null>;
  /** A workspace's rendered avatars, newest first. */
  list(workspaceId: string): Promise<StoredAvatar[]>;
}

/**
 * In-memory {@link AvatarStudioStore} for unit tests. Deterministic: ids are a monotonic counter and the clock is
 * injected through the service, so a test never depends on wall-clock time or a uuid. Enforces the same
 * first-write-wins idempotency as the Postgres binding.
 */
export class InMemoryAvatarStudioStore implements AvatarStudioStore {
  private readonly rows = new Map<string, StoredAvatar>();
  private seq = 0;

  private key(workspaceId: string, avatarId: string): string {
    return `${workspaceId}::${avatarId}`;
  }

  async create(input: CreateAvatarInput): Promise<StoredAvatar> {
    const k = this.key(input.workspaceId, input.avatarId);
    const existing = this.rows.get(k);
    if (existing) return this.clone(existing);
    const row: StoredAvatar = {
      id: `avatar-${++this.seq}`,
      workspaceId: input.workspaceId,
      avatarId: input.avatarId,
      displayName: input.displayName,
      config: input.config,
      provider: input.provider,
      requestedByMemberId: input.requestedByMemberId,
      createdAt: input.createdAt,
    };
    this.rows.set(k, row);
    return this.clone(row);
  }

  async getByAvatarId(workspaceId: string, avatarId: string): Promise<StoredAvatar | null> {
    const row = this.rows.get(this.key(workspaceId, avatarId));
    return row ? this.clone(row) : null;
  }

  async list(workspaceId: string): Promise<StoredAvatar[]> {
    return [...this.rows.values()]
      .filter((r) => r.workspaceId === workspaceId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .map((r) => this.clone(r));
  }

  private clone(row: StoredAvatar): StoredAvatar {
    return {
      ...row,
      config: {
        face: { ...row.config.face },
        voice: { ...row.config.voice },
      },
    };
  }
}
