import { DEFAULT_SENSITIVE_ACTIONS } from "../approvals/policy.js";

/**
 * Invariant action classes for Evidence-Priced Autonomy (#119, ADR-0119). These can **NEVER**
 * auto-relax, no matter how clean the evidence window looks. The list is **derived from the #13 hard
 * list** (`DEFAULT_SENSITIVE_ACTIONS` — outbound money, external sends, `autonomy.complete`,
 * `dr.restore`) plus secrets access, so any future addition to the #13 hard list is *automatically*
 * an invariant here — they can never drift apart.
 *
 * The guarantee is **structural, not convention**: a `RELAX` recommendation (see `pricing.ts`) carries
 * a branded {@link RelaxableActionType}, and the only constructor of that type — {@link relaxableAction}
 * — returns `null` for an invariant class. A `RELAX` for an invariant is therefore unconstructable, and
 * a unit test proves it (a runtime assertion plus a `@ts-expect-error` compile check).
 */

/**
 * Secrets access — a #119-introduced invariant class. It is not yet a #13 `ActionType`, but reading
 * secrets is irreversible-by-disclosure and must always stay behind a human, so it is named explicitly.
 */
export const SECRETS_ACCESS_ACTION = "secrets.access" as const;

/** The action classes that can never auto-relax: the #13 hard list ∪ secrets access. */
export const INVARIANT_ACTION_TYPES: readonly string[] = [
  ...DEFAULT_SENSITIVE_ACTIONS,
  SECRETS_ACCESS_ACTION,
];

/** True iff `actionType` is an invariant class barred from ever auto-relaxing. */
export function isInvariantAction(actionType: string): boolean {
  return INVARIANT_ACTION_TYPES.includes(actionType);
}

declare const RELAXABLE_BRAND: unique symbol;

/**
 * An action class **proven not to be an invariant** — the only thing a `RELAX` recommendation may
 * carry. The brand is unforgeable: the sole constructor is {@link relaxableAction}. There is no way to
 * obtain a `RelaxableActionType` for an invariant class, so the compiler refuses a `RELAX` for one.
 */
export type RelaxableActionType = string & { readonly [RELAXABLE_BRAND]: true };

/**
 * The sole constructor of {@link RelaxableActionType}. Returns the branded action for a reversible
 * class, or `null` for an invariant class — the structural gate that makes auto-relaxing an invariant
 * impossible to express.
 */
export function relaxableAction(actionType: string): RelaxableActionType | null {
  return isInvariantAction(actionType) ? null : (actionType as RelaxableActionType);
}

/**
 * Compile-time proof of the structural guarantee — **validated by `pnpm typecheck`** (the server
 * tsconfig type-checks `src`, so this runs on every CI typecheck). It has no runtime effect; it exists
 * so the boundary "an invariant class can never be presented as relaxable" is enforced *by the type
 * system*, exactly as the issue requires ("enforced in types/tests, not convention").
 *
 * The only constructor of {@link RelaxableActionType} is {@link relaxableAction}, which returns `null`
 * for an invariant. The `@ts-expect-error` below asserts a raw string is **not** assignable to the
 * unforgeable brand — so a `RELAX` recommendation (which carries a `RelaxableActionType`) can never be
 * constructed for an invariant action. If the brand is ever weakened, the directive becomes an unused
 * `@ts-expect-error` and **typecheck FAILS** — the proof breaks the build, not a convention.
 */
export function __assertInvariantsCannotRelax(): void {
  // @ts-expect-error — a raw invariant string is not assignable to the branded RelaxableActionType.
  const _forced: RelaxableActionType = "billing.payout";
  void _forced;
}
