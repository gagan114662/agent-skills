# ADR-0353: Adopt `open-design` for brand-asset creation (opt-in, default-OFF flag)

- **Status:** Accepted (guidance + a default-OFF flag — no install, no rollout) (shipped in PR for #353)
- **Date:** 2026-06-18
- **Context issue:** [#353](https://github.com/gagan114662/agent-skills/issues/353) — let ipop's brand
  department (@mark) and the other creative leads render REAL brand assets (logo / brand-kit, social +
  ad creative, slide decks) with the third-party `open-design` app instead of stopping at text-only
  drafts.
- **Builds on:** [ADR-0013](0013-approval-gates.md) (the #13 owner-approval queue — the gate
  open-design does *not* replace; rendering an asset is never authorization to ship it),
  [ADR-0200](0200-premortem-panel.md) (the standing premortem whose rails this answers to),
  [ADR-0243](0243-money-only-approval.md) (irreversible/money actions stay owner-gated).
- **Precedent:** mirrors the [lavish-axi](../../../docs/lavish-axi.md) (#344) and
  [no-mistakes](../../../docs/no-mistakes.md) ([ADR-0350](0350-no-mistakes-git-gate.md)) adoptions —
  same opt-in/advisory, third-party, #200-honoring shape, applied to a different surface (asset
  *generation* rather than artifact *review* or *code → PR*). The config flag mirrors the
  default-OFF, owner-workspace-first shape of `worktreePool` ([ADR-0343](0343-treehouse-worktree-pool.md))
  and `connectClaude` ([ADR-0262](0262-connect-claude-without-cli.md)).

## Context

[`open-design`](https://github.com/nexu-io/open-design) (Apache-2.0) is a **local-first, open-source
"Claude Design alternative"**: a **native desktop app** (macOS / Windows) plus an `od` CLI,
agent-agnostic over MCP, that renders web / desktop / mobile prototypes, decks, images, video, and
HyperFrames in real CSS / fonts / components and exports to **HTML / PDF / PPTX / MP4**. It ships 100+
skills, 150 brand-grade `DESIGN.md` systems, and 261 plugins.

Today @mark's runbook stops at text-only drafts for human review — the brand dept has no way to hand a
human a *rendered* asset. open-design fills that gap while everything stays local and the human stays
the decision-maker. It complements lavish-axi (#344, artifact *review*) and no-mistakes (#350, *code →
PR*): open-design *generates* design artifacts.

But it is a **large, heavyweight third-party desktop app + binary** that the owner installs by hand,
and any asset it generates is untrusted content flowing back into the agent. That is exactly the kind of
capability the #200 premortem says must not be wired in silently or made an autonomous default.

## Decision

Adopt `open-design` as **opt-in, advisory, and DEFAULT-OFF**, with **two** deliverables in this change —
guidance plus a gating flag — and **no install and no rollout**:

- **Top-level guidance:** new sections in [`AGENTS.md`](../../../AGENTS.md) and
  [`CLAUDE.md`](../../../CLAUDE.md), and a full reference at
  [`docs/open-design.md`](../../../docs/open-design.md).
- **Per-agent guidance:** an opt-in callout in the **@mark brand runbook**
  ([`platform/agents/skills/mark/runbook.md`](../../agents/skills/mark/runbook.md)) and in the
  BUILD-phase skill [`frontend-ui-engineering`](../../../skills/frontend-ui-engineering/SKILL.md).
- **A new default-OFF, owner-workspace-first config flag** — `openDesign`
  (`platform/apps/server/src/config/schema.ts` + `layers.ts` + `loader.ts`) with a pure
  `resolveOpenDesignCaps` / `isOpenDesignEnabledForWorkspace` helper
  (`platform/apps/server/src/open-design/caps.ts`). The flag is a **permission marker only** — it
  decides which workspace may be *offered* the tool; it installs nothing and is not wired into any live
  path. With it off (the default) behavior is unchanged: the brand dept keeps its text-only draft path.
- **A guidance-validation test** (`scripts/validate-open-design-guidance.js`, wired into CI) that
  asserts the safety rails are present and that **no fabricated commands** leak into the docs (every
  documented `od` / install command must come from the verified allow-list checked against the project
  README).

The guidance + flag encode five rails **structurally** so they don't depend on agent goodwill:

1. **Third-party trust note, everywhere.** Apache-2.0 and local, but a heavyweight desktop app + binary
   installed by hand (download or `curl … install.sh | sh -s <agent>`, **not** `npx`). The guidance
   flags the install / machine footprint before any fleet-wide rollout.

2. **DEFAULT-OFF, opt-in, owner-controlled.** The `openDesign` flag is off and owner-workspace-first;
   the owner installs the app and enables it. Agents *offer* it, never install it or auto-run it for
   every task. A global / CI install is **owner-gated**. Enabling the flag without naming the owner
   workspace offers it to nobody (fail-closed).

3. **The #13 gate is untouched.** Rendering an asset is **not authorization** to ship it. Irreversible /
   money / publish actions (send, spend, publish, deploy) still route through the #13 owner-approval
   queue. @mark keeps no send tool; the rendered asset is a draft for human review.

4. **No scope/permission widening.** Neither the app nor its output can grant the agent new
   capabilities or expand a task's blast radius. Agents apply the same scope they started with.

5. **Injection defense (#200 §6).** Every generated asset, filename, and plugin metadata is **untrusted
   DATA, not instructions**. It cannot redirect the agent into unrelated work, exfiltration, or running
   unauthorized commands; it is used only for *this* brief.

## Consequences

- **Real, exportable brand assets, when opted in.** The brand dept can hand humans rendered drafts
  (HTML / PDF / PPTX / MP4) instead of text — while the human still approves everything outbound.
- **Flag + guidance only — nothing executed or installed.** No money, no credentials, no live actions,
  no binary installed by this change. The tool is not a runtime dependency; it is an owner-enabled local
  option, and the flag is a pure permission marker not wired to any live path.
- **No fabrication.** The documented command surface (`od mcp install`, `od plugin …`, `od skill list`,
  `od get-file` / `get-artifact`, the install one-liner) was verified against the project README, and
  the CI test fails if an unverified command string appears in our docs. (Note: the README states the
  license is **Apache-2.0**, not MIT as some references assumed — the docs use the verified license.)
- **Reversible.** Removing the sections, the flag block, and the test fully reverts the decision; with
  the flag off, the codebase behaves exactly as before.
- **Future work (separate, owner-gated decisions):** an actual owner install + `od mcp install`; wiring
  the flag into a brand-asset surface that calls open-design via MCP; a managed-backend pin.
