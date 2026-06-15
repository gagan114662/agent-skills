import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { members } from "./identities.js";

/**
 * Per-tenant agent credentials vault (issue #68, ADR-0068).
 *
 * Holds a workspace's own Claude subscription token (`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`)
 * so its fleet agents run on the OWNER's subscription — never a pooled platform key. One row per
 * workspace (`workspace_id` is the primary key), which is what makes pooling structurally impossible:
 * a resolve is keyed by workspace and reads exactly one row.
 *
 * `claude_oauth_token` is stored **sealed** (AES-256-GCM via `crypto/secretbox`) when
 * `AGENT_CREDENTIALS_ENC_KEY` is configured, and is NEVER returned by any API — only injected into a
 * runtime as env (where the SessionManager redactor scrubs it from output/logs). `token_fingerprint`
 * is a non-reversible hash used solely to show "connected" in the UI without exposing the token.
 */
export const workspaceAgentCredentials = pgTable("workspace_agent_credentials", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** Sealed CLAUDE_CODE_OAUTH_TOKEN (ciphertext when a key is set; marked pass-through otherwise). */
  claudeOauthToken: text("claude_oauth_token").notNull(),
  /** Non-reversible fingerprint for the UI's connected state — never the token itself. */
  tokenFingerprint: text("token_fingerprint").notNull(),
  /**
   * The owner-picked fleet model for this workspace (#246) — a NON-secret, validated against the models
   * known to resolve before it's stored. NULL ⇒ the deployment default (`ANTHROPIC_MODEL` → the canonical
   * `claude-opus-4-8`). Read at launch and injected as the session's `ANTHROPIC_MODEL`; a per-session #52
   * selection still overrides it. Migration 0246 rewrites any stored `claude-fable-5` to the opus default.
   */
  model: text("model"),
  /** The member who connected it (audit). Soft — survives member deletion. */
  connectedByMemberId: uuid("connected_by_member_id").references(() => members.id, {
    onDelete: "set null",
  }),
  connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
