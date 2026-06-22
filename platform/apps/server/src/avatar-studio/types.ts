/**
 * Shared types for the AI UGC avatar studio (issue #741).
 *
 * The problem: short-form UGC ("user-generated content") creative wants a recurring, recognizable on-camera
 * persona — the same face and the same voice across every clip in a campaign — but an avatar/video render API
 * is an external, money-and-rate-limited dependency. This module gives the fleet a deterministic studio: a
 * persona (a creative brief) renders into a concrete face + voice CONFIG, and the SAME `avatarId` always yields
 * the SAME config, so a campaign's avatar stays consistent clip to clip.
 *
 * Everything here is plain data. The pure derivation core (`render.ts`) reads only the structural `avatarId`
 * and `locale` — never the free-text `personaHints` — so an injected hint string can never steer the config
 * (#200 §6 trust boundary). No external call happens until a deployment explicitly enables the studio AND wires
 * a live provider; the shipped default is a deterministic FAKE that calls nothing.
 */

/**
 * A persona is the creative brief for one recurring UGC avatar. `avatarId` is the stable identity key: two
 * renders that share an `avatarId` are the SAME on-camera person and MUST resolve to the same face + voice.
 */
export interface AvatarPersona {
  /** Stable identity key for the avatar. Non-empty; the sole structural input to the deterministic derivation. */
  avatarId: string;
  /** Human label shown in the studio UI. Cosmetic — never read by the deterministic core. */
  displayName: string;
  /**
   * Optional free-text creative direction ("warm gen-z founder, casual"). NEVER read by the derivation core —
   * it is carried for human review only, so a poisoned hint cannot flip the rendered config (#200 §6).
   */
  personaHints?: string | null;
  /** BCP-47 voice locale (e.g. "en-US"). Missing ⇒ the studio default locale. */
  locale?: string | null;
}

/** A concrete face descriptor, deterministically chosen from a fixed catalog by the avatar's seed. */
export interface FaceConfig {
  /** The deterministic 32-bit seed derived from `avatarId` (same id ⇒ same seed). */
  seed: number;
  skinTone: string;
  hairStyle: string;
  hairColor: string;
  eyeColor: string;
  /** A face accessory ("none" is a valid, common choice). */
  accessory: string;
}

/** A concrete voice descriptor, deterministically chosen from a fixed catalog by the avatar's seed. */
export interface VoiceConfig {
  /** Stable synthetic voice id derived from `avatarId`. */
  voiceId: string;
  timbre: string;
  /** Resolved BCP-47 locale (persona locale, or the studio default). */
  locale: string;
  /** Pitch shift in semitones, quantized to a stable integer in [-6, 6]. */
  pitchSemitones: number;
  /** Speaking-rate multiplier, quantized to two decimals in [0.85, 1.15]. */
  speakingRate: number;
}

/** The full rendered look + sound of a persona. */
export interface AvatarConfig {
  face: FaceConfig;
  voice: VoiceConfig;
}

/** A rendered avatar as returned to a caller (the config plus its identity and the provider that produced it). */
export interface RenderedAvatar {
  avatarId: string;
  displayName: string;
  config: AvatarConfig;
  /**
   * Which provider produced this config: `"fake"` for the deterministic default/fallback, or an external
   * provider's name when a live provider is wired and enabled.
   */
  provider: string;
}
