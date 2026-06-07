/**
 * @mention parsing (issue #6). Pure and dependency-free so it runs in the no-Redis unit job
 * and can be reused anywhere. Resolution (token → member) and persistence live in the
 * mentions repository; this only turns a raw body into candidate handle tokens.
 *
 * A mention is `@` + handle, where the `@` is NOT preceded by a word character (so an email
 * like `user@host` is not a mention) and the handle is one or more of `[A-Za-z0-9._-]`.
 * Tokens are lowercased and de-duplicated, preserving first-appearance order.
 */
const MENTION_RE = /(^|[^\w@])@([A-Za-z0-9._-]+)/g;

export function parseMentionTokens(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of body.matchAll(MENTION_RE)) {
    const token = match[2]!.toLowerCase();
    if (!seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}
