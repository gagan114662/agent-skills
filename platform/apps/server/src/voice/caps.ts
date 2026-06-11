import type { VoiceConfig } from "../config/schema.js";

/**
 * Resolve the Customer Voice policy from the layered config (#58), applying hard defaults — mirrors
 * `growth/caps.ts`. The voice loop is **default OFF** (`enabled: false`, `autoTriageDraft: false`): a
 * deployment that sets no `voice` section ingests + classifies + reads as normal (harmless, tenant-scoped)
 * but never has an agent draft a reply proactively. `enabled`/`autoTriageDraft` gate only the proactive
 * triage-draft posture; the outbound send itself is ALWAYS the #13 human gate regardless.
 */
export interface VoiceCaps {
  /** The proactive-voice flag. OFF by default. */
  enabled: boolean;
  /** The window (days) the voice-of-customer digest rolls up. */
  digestWindowDays: number;
  /** Whether the triage agent drafts a reply on ticket ingest. OFF by default (ticket lands open). */
  autoTriageDraft: boolean;
}

export const VOICE_DEFAULTS: VoiceCaps = {
  enabled: false,
  digestWindowDays: 7,
  autoTriageDraft: false,
};

export function resolveVoiceCaps(cfg: VoiceConfig | undefined): VoiceCaps {
  return {
    enabled: cfg?.enabled ?? VOICE_DEFAULTS.enabled,
    digestWindowDays: cfg?.digestWindowDays ?? VOICE_DEFAULTS.digestWindowDays,
    autoTriageDraft: cfg?.autoTriageDraft ?? VOICE_DEFAULTS.autoTriageDraft,
  };
}
