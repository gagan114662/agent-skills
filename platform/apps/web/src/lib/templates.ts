/**
 * Client-side task-template variable handling (#167). The server owns the canonical renderer
 * (`automations/templates.ts`), but the web app can't import server code, so the composer carries this
 * tiny pure mirror: it substitutes `{{var}}` placeholders the user fills in the picker, and detects any
 * placeholder left unresolved so the composer can block send. Same `{{word}}` grammar as the server.
 */

/** Matches a single `{{name}}` token (word chars only), mirroring the server renderer's grammar. */
const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/**
 * The list of distinct placeholder names still present in `text` (e.g. `["site"]` for `"...{{site}}..."`).
 * Empty when the text is fully resolved. Pure — never throws.
 */
export function unresolvedPlaceholders(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(PLACEHOLDER)) if (m[1]) seen.add(m[1]);
  return [...seen];
}

/** True when `text` still contains at least one `{{placeholder}}`. */
export function hasUnresolvedPlaceholders(text: string): boolean {
  return unresolvedPlaceholders(text).length > 0;
}

/**
 * Substitute every `{{name}}` in `body` with `values[name]`. A missing or blank value is left as the
 * literal `{{name}}` token on purpose — so the composer's send guard still catches it. Pure.
 */
export function fillTemplate(body: string, values: Record<string, string>): string {
  return body.replace(PLACEHOLDER, (match, name: string) => {
    const value = values[name];
    return value !== undefined && value.trim() !== "" ? value : match;
  });
}
