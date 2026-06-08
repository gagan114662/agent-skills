import { getMessage, type Message } from "../db/repositories/messages.js";

/**
 * Resolve the thread root for a target message id, scoped to a channel (#6). Returns the root
 * message when the target exists, is not deleted, and belongs to `channelId`; if the target is
 * itself a reply, returns its parent (threads stay one level deep). Returns undefined for a missing
 * / cross-channel target so callers (the #4 channel routes and the #10 MCP `reply_thread` tool) can
 * answer 404 / a tool error identically.
 */
export async function resolveThreadRoot(
  messageId: string,
  channelId: string,
): Promise<Message | undefined> {
  const target = await getMessage(messageId);
  if (!target || target.channelId !== channelId) return undefined;
  if (!target.parentMessageId) return target;
  const parent = await getMessage(target.parentMessageId);
  return parent && parent.channelId === channelId ? parent : undefined;
}
