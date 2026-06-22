/**
 * The PURE derivation core of the AI UGC avatar studio (issue #741). Given a {@link AvatarPersona}, it returns a
 * concrete {@link AvatarConfig} (face + voice) by hashing the persona's stable `avatarId` and indexing fixed
 * catalogs. No IO, no clock, no randomness — so the SAME `avatarId` ALWAYS yields the SAME face and voice. That
 * determinism is the heart of the studio's promise (a campaign's avatar is recognizable clip to clip) and is what
 * lets the {@link FakeAvatarProvider} produce stable output with zero external calls.
 *
 * Only structural fields are read: `avatarId` (the seed) and `locale` (the voice locale). The free-text
 * `personaHints` is deliberately ignored here, so a poisoned hint can never change the rendered config (#200 §6).
 */

import type { AvatarConfig, AvatarPersona, FaceConfig, VoiceConfig } from "./types.js";

/** Default voice locale when a persona does not specify one. */
export const DEFAULT_AVATAR_LOCALE = "en-US";

// Fixed catalogs. Order is part of the contract: changing it would re-key existing avatars, so it is append-only.
const SKIN_TONES = ["porcelain", "fair", "light", "medium", "tan", "brown", "deep", "ebony"] as const;
const HAIR_STYLES = ["short-crop", "buzz", "wavy-bob", "long-straight", "curly", "ponytail", "afro", "bald"] as const;
const HAIR_COLORS = ["black", "dark-brown", "brown", "auburn", "blonde", "platinum", "red", "grey"] as const;
const EYE_COLORS = ["brown", "hazel", "green", "blue", "grey", "amber"] as const;
const ACCESSORIES = ["none", "none", "glasses", "earrings", "cap", "headphones"] as const;
const VOICE_TIMBRES = ["bright", "warm", "deep", "soft", "energetic", "calm", "raspy", "smooth"] as const;

/**
 * FNV-1a 32-bit hash — a small, fast, fully deterministic string hash (no crypto, no platform variance). Returns
 * an unsigned 32-bit integer. Used as the avatar seed; identical input ⇒ identical output on every machine.
 */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts, kept in 32-bit unsigned space.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/** A field-scoped hash so independent attributes vary without correlating (face vs voice vs pitch). */
function fieldHash(avatarId: string, field: string): number {
  return fnv1a32(`${avatarId}::${field}`);
}

/** Pick a catalog entry deterministically by hashed index. The catalog is non-empty by construction. */
function pick<T>(catalog: readonly T[], hash: number): T {
  return catalog[hash % catalog.length]!;
}

/** Map a hash into an inclusive integer range [min, max], deterministically and uniformly enough for config. */
function intInRange(hash: number, min: number, max: number): number {
  const span = max - min + 1;
  return min + (hash % span);
}

/** Normalize a possibly-missing locale to a trimmed value, falling back to the studio default. */
function resolveLocale(locale: string | null | undefined): string {
  const trimmed = (locale ?? "").trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_AVATAR_LOCALE;
}

/** Derive the deterministic face for an avatar id. */
export function deriveFace(avatarId: string): FaceConfig {
  const seed = fnv1a32(avatarId);
  return {
    seed,
    skinTone: pick(SKIN_TONES, fieldHash(avatarId, "skin")),
    hairStyle: pick(HAIR_STYLES, fieldHash(avatarId, "hair-style")),
    hairColor: pick(HAIR_COLORS, fieldHash(avatarId, "hair-color")),
    eyeColor: pick(EYE_COLORS, fieldHash(avatarId, "eye")),
    accessory: pick(ACCESSORIES, fieldHash(avatarId, "accessory")),
  };
}

/** Derive the deterministic voice for an avatar id at a resolved locale. */
export function deriveVoice(avatarId: string, locale: string | null | undefined): VoiceConfig {
  const pitch = intInRange(fieldHash(avatarId, "pitch"), -6, 6);
  // Speaking rate: integer 0..30 → 0.85..1.15 in 0.01 steps, kept to two decimals to avoid float drift.
  const rateSteps = intInRange(fieldHash(avatarId, "rate"), 0, 30);
  const speakingRate = Math.round((0.85 + rateSteps / 100) * 100) / 100;
  return {
    voiceId: `ugc-voice-${(fnv1a32(`voice::${avatarId}`) >>> 0).toString(16).padStart(8, "0")}`,
    timbre: pick(VOICE_TIMBRES, fieldHash(avatarId, "timbre")),
    locale: resolveLocale(locale),
    pitchSemitones: pitch,
    speakingRate,
  };
}

/**
 * Derive the full deterministic {@link AvatarConfig} for a persona. Pure + total: depends only on `avatarId`
 * and `locale`. Throws on a blank `avatarId` — there is nothing stable to seed from (a "missing avatar").
 */
export function deriveAvatarConfig(persona: AvatarPersona): AvatarConfig {
  const avatarId = persona.avatarId.trim();
  if (avatarId.length === 0) {
    throw new Error("avatar-studio: cannot derive a config for a blank avatarId");
  }
  return {
    face: deriveFace(avatarId),
    voice: deriveVoice(avatarId, persona.locale),
  };
}
