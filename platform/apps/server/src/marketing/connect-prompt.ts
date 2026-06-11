/**
 * The friendly brand-voice "connect your Claude account" message (#68, ADR-0068).
 *
 * When a fleet agent is @mentioned but the workspace hasn't connected a Claude subscription (and the
 * operator set no platform key), the persona posts THIS instead of silently doing nothing or crashing.
 * It is the owner-facing front of the subscription-first auth model: warm, on-brand (pop voice), and
 * actionable — one sentence on what's missing, one on exactly how to fix it.
 */
export function buildConnectPrompt(personaName: string): string {
  return (
    `👋 Hey — it's @${personaName}. I'd love to jump on this, but this workspace hasn't ` +
    `connected a Claude account yet, so I can't spin up a real session.\n\n` +
    `Ask the workspace owner to head to **Settings → Connect Claude** and paste a token from ` +
    "`claude setup-token` — then @mention me again and I'll get right to work. ✨"
  );
}
