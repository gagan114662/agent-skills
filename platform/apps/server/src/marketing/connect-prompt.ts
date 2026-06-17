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
    `Ask the workspace owner to head to **Settings → Connect Claude** and connect your account ` +
    `(no terminal needed) — then @mention me again and I'll get right to work. ✨`
  );
}

/**
 * The friendly brand-voice "pick a valid model" message (#246).
 *
 * When a fleet agent is @mentioned but the workspace's configured model isn't one that resolves on the
 * subscription (the `claude-fable-5` class that 403'd every session), the persona posts THIS instead of
 * launching a doomed session that crashes mid-run. The model id is the owner's own non-secret config
 * value (not a credential), so naming it is safe — and it's exactly what makes the message actionable.
 */
export function buildModelPrompt(personaName: string, model: string): string {
  return (
    `👋 Hey — it's @${personaName}. I tried to get going, but the AI model this workspace is set to ` +
    `use (\`${model}\`) isn't available on your Claude plan, so I can't run.\n\n` +
    `Ask the workspace owner to pick a valid model in **Settings → Connect Claude → Model** ` +
    `(or clear it to use the default) — then @mention me again and I'll get right to work. ✨`
  );
}
