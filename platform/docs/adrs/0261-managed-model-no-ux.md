# ADR-0261: The model is managed — removed from the UX, never broken

- **Status:** Accepted
- **Date:** 2026-06-19
- **Context issue:** [#261](https://github.com/gagan114662/agent-skills/issues/261) — remove model
  configuration from the user experience. The owner should never pick a model or see a
  "model unavailable" error.
- **Closes the class of:** [#292](https://github.com/gagan114662/agent-skills/issues/292) /
  [#242](https://github.com/gagan114662/agent-skills/issues/242) — a configured/stale/removed model id the
  API can't serve reaching the harness and failing the run ("error · exit 1" after `claude-fable-5` was set
  deployment-wide).
- **Builds on:** [ADR-0029](0029-multi-model-selection.md) (#52 per-session selection), the #246 managed
  default (`claude-opus-4-8`).

## Context

The model was a configurable value the owner could set: a per-session #52 pick, a workspace/dev override, or
the deployment `ANTHROPIC_MODEL`. Two problems followed:

1. **It could break the fleet.** A stale or removed model id (the live-confirmed `claude-fable-5`) flowed
   through to `claude -p --model "$ANTHROPIC_MODEL"`, which the API 403/`model_not_found`s, so every session
   exited 1 having produced nothing — surfaced to the owner as an opaque "model unavailable" / "error · exit
   1" (#292/#242).
2. **It was owner-facing UX with no upside.** The owner has no reason to choose an AI model; the platform
   knows the one known-good default to run. A picker only created a foot-gun (problem 1) and noise.

Owner decision: the model is **managed** — always a known-good default, never configured by the owner, never
a source of a failed run.

## Decision

Two changes — a server "never broken" guarantee (the load-bearing half) and a web removal.

### Server — total, self-healing model resolution (the guarantee)

The runtime boundary already resolved the launch model through `resolveLaunchModel` (wired in
`runtime/manager.ts:applyModelPreflight`, which **always** injects the resolved `ANTHROPIC_MODEL` into the
child env before any spawn). This ADR makes the clamp an explicit, independently-tested pure unit:

```
resolveManagedModel(requested, known, fallback): string
```

— a model that is present in `known` is kept; anything else (empty, null, whitespace, or an
unknown/removed/unavailable id — the `claude-fable-5` class) clamps to the managed `fallback`. No clock, no
IO, no env read; `known`/`fallback` are passed in. `resolveLaunchModel` walks the precedence chain
(per-session pin > workspace/dev override > deployment env default) and returns the first candidate that
survives this clamp, else the managed `DEFAULT_AGENT_MODEL` (`claude-opus-4-8`), which is itself always
known-good.

The clamp is **conservative**: a valid known model is never second-guessed — only an unknown/unavailable or
empty value is replaced. The admin save path (`assertModelLaunchable`) still throws `ModelUnavailableError`
for a human who *explicitly typed* a bad id; the **runtime** never throws — a bad stored/env value can never
reach the harness or disable the fleet. This directly closes the #292/#242 class.

### Web — the model picker is removed from the owner's flow

`ReviewPanel` no longer renders the "New session model" launch control (the `ModelSelector` picker —
provider / model / effort / Auto). The owner configures nothing; the managed default is used. The
`ModelSelector` component, its `ModelSelection` types, and `DEFAULT_SELECTION` are **kept exported**
(imported by tests and available for a future operator/dev-only surface) — only their use in the product
flow is removed. `ModelBadge` (a read-only display of what a session ran with) stays. The Settings sheet's
"Models" tab was already only a connected-status row + write-only cloud-key inputs — never a model picker —
so it is unchanged. The now-dead `.review__launch*` CSS rules were removed (the `.modelsel*` rules stay —
still used by the exported component).

## #200 rails

- **No new action path, no money, no irreversible step.** A pure server clamp + a web removal. Every
  irreversible/money action still stops at the #13 gate.
- **Conservative / fail-safe by construction:** the clamp only ever *narrows* to a known-good model; it can
  never widen scope or pick something the deployment doesn't already allow (the `known` set is the
  deployment's curated list + the `RELOAD_KNOWN_MODELS` escape hatch).
- **No types/exports other code depends on were broken** — `ModelSelector`, `ModelSelection`,
  `DEFAULT_SELECTION`, `ModelBadge`, and the whole `runtime/models.ts` surface remain exported.

## Tests

- Server: new `resolveManagedModel` unit group in `test/unit/models.test.ts` — known ⇒ kept, unknown ⇒
  default, empty/null/undefined/whitespace ⇒ default, purity (consults only the passed-in set + returns the
  exact fallback). The existing `resolveLaunchModel` suite (the precedence walk + self-heal) continues to
  pass unchanged.
- Web: `ReviewPanel.test.tsx` gains a regression case asserting the model picker (the "New session model"
  control, the "Model selection" group, the Provider/Model inputs) is **absent** from the flow.
  `ModelSelector.test.tsx` still exercises the (retained, exported) component directly.

## Alternatives considered

- **Delete `ModelSelector` outright.** Rejected — it is still imported by its test and is a useful
  operator/dev affordance; removing it from the product flow achieves the goal without breaking exports.
- **Gate the picker behind a default-ON "managed" flag.** Rejected as unnecessary indirection — the owner
  has no reason to ever pick a model, so a clean removal from the flow is simpler and the server clamp is the
  real guarantee regardless of any UI affordance.

## Follow-up

- If any future surface needs an operator-only model override, it can reuse the still-exported
  `ModelSelector` behind an operator route; the server clamp keeps even that override "never broken".
