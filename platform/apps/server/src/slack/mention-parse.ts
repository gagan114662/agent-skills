/**
 * Pure Slack-text → platform-message translation (#170). A Slack `app_mention` arrives as e.g.
 * `<@U0BOT> scout audit acme.com`. To reuse the EXISTING #123 mention path verbatim, we translate it
 * into a platform message whose first token is an `@handle` the personas repo resolves
 * (`@scout audit acme.com`). No new launch authority — we only shape text the existing trigger reads.
 *
 * Rules:
 *  - strip the bot's own `<@BOT>` mention (Slack wraps user mentions as `<@Uxxx>`);
 *  - the first remaining word names the target agent → prefix it with `@` (unless already prefixed);
 *  - everything else is the brief, passed through unchanged.
 */

/** Remove every `<@Uxxx>` / `<@Uxxx|name>` user-mention token (Slack's wire format). */
function stripUserMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, " ");
}

/**
 * Translate a raw Slack app_mention body into a platform message body whose leading token is an
 * `@handle`. Returns null when there is no brief left after stripping mentions (nothing actionable).
 */
export function slackMentionToPlatformMessage(rawText: string): string | null {
  const stripped = stripUserMentions(rawText).replace(/\s+/g, " ").trim();
  if (!stripped) return null;
  const spaceIdx = stripped.indexOf(" ");
  const firstWord = spaceIdx === -1 ? stripped : stripped.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? "" : stripped.slice(spaceIdx + 1);
  const handle = firstWord.startsWith("@") ? firstWord : `@${firstWord}`;
  return rest ? `${handle} ${rest}` : handle;
}
