/**
 * Autonomy-defaults config (issue #727). Deliberately **self-contained**: the per-capability and per-channel
 * opt-OUT toggles are read directly from the process environment, so this feature adds NO edit to the shared
 * `config/schema.ts` barrel and stays free of parallel-merge conflicts with sibling branches (the #592 / #670 /
 * #674 pattern).
 *
 * The inversion that defines this issue: every toggle DEFAULTS ON. A deployment (or workspace) that sets nothing
 * has ALL capabilities and ALL channels enabled — autonomous out of the box, zero switch-flipping. The env can
 * only DIAL DOWN: naming a capability/channel in the disable list switches just that one off (it then routes to
 * the review queue). There is intentionally NO env that turns the money gate off — money is not in this set.
 */

import {
  AUTONOMY_DEFAULTS_ALL_ON,
  CAPABILITIES,
  CHANNELS,
  type AutonomyCaps,
  type Capability,
  type Channel,
} from "./defaults.js";

/** Parse a comma/space separated list of names; empty/missing ⇒ no names. Lowercased, trimmed, de-duped. */
function parseNameList(raw: string | undefined): string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(/[\s,]+/)
        .map((v) => v.trim().toLowerCase())
        .filter((v) => v.length > 0),
    ),
  ];
}

function isCapability(s: string): s is Capability {
  return (CAPABILITIES as readonly string[]).includes(s);
}

function isChannel(s: string): s is Channel {
  return (CHANNELS as readonly string[]).includes(s);
}

/**
 * Resolve the autonomy caps from the environment (all-ON defaults, opt-out applied). Pure given its `env`
 * argument. `AUTONOMY_DISABLE_CAPABILITIES` / `AUTONOMY_DISABLE_CHANNELS` are comma/space lists of names to dial
 * OFF; an unknown name is ignored (a typo never silently disables the wrong thing). Money is never affected.
 */
export function resolveAutonomyCaps(env: NodeJS.ProcessEnv = process.env): AutonomyCaps {
  const capabilities: Record<Capability, boolean> = { ...AUTONOMY_DEFAULTS_ALL_ON.capabilities };
  const channels: Record<Channel, boolean> = { ...AUTONOMY_DEFAULTS_ALL_ON.channels };

  for (const name of parseNameList(env.AUTONOMY_DISABLE_CAPABILITIES)) {
    if (isCapability(name)) capabilities[name] = false;
  }
  for (const name of parseNameList(env.AUTONOMY_DISABLE_CHANNELS)) {
    if (isChannel(name)) channels[name] = false;
  }

  return { capabilities, channels };
}
