# ADR-0199: Console v5 — the two-pane, simplified Conductor-style board

- **Status:** Accepted (pending owner video-gate sign-off)
- **Date:** 2026-06-13
- **Context issue:** Approved v5 console redesign (supersedes the #199 board + standup layout)
- **Supersedes the layout of:** the #199 console (`feat(web): console redesign — board + standup panel
  per brand book`). The honest seams and the pure `model.ts` from #199 are kept verbatim; only the chrome
  changes.
- **Builds on / reuses:** [ADR-0013](0013-approval-gates.md) (human approval gates — the Approve/Not yet pair
  decides here), [ADR-0050](0050-founder-console.md) (#104 spend/fleet seam → the header gauge +
  fleet-health), #147 mission control (live sessions → the board's "Work in progress" lane),
  [ADR-0068](0068-subscription-first-agent-auth.md) (Connect-Claude → the settings overlay),
  [ADR-0138](0138-pop-identity-channels-deploy.md) (brand: Paper/Ink/Vermilion, the popped i-dot), #153 (trial → pricing
  funnel → the pricing overlay).

## Context

The #199 console already split the product into a left projects→sessions panel and a center board, wired
to real seams. But it still lived **inside** the old multi-tab shell: a top nav strip with eleven buttons
(Board / Chat / Founder / Automations / Catalog / Workflows / Mission / Audit / Approvals / Deploy /
Pricing) plus Settings. The approved v5 mockup
(`/Users/gaganarora/Desktop/my projects/agent_skills/ipop-console-v5.html`) makes a stronger claim: the
**whole product is two panes**. No tab strip. You see your work, you dive into a task, you steer it or
approve it. Everything else is noise.

The design goal is to make the irreducible human loop — *see what the fleet is doing → decide what needs a
human → steer or approve* — the entire surface, with one status grammar everywhere (braille = working,
vermilion dot = needs you, green dot = done) and department shown only as a 3px card edge.

## Decisions

1. **The two-pane console is the default — and only — authed chrome. The top nav is gone.** `Workspace.tsx`
   is now a trivial full-height wrapper around `ConsoleView`; the eleven-tab `TopBar` was deleted, not
   hidden. The off-board panels (Founder, Automations, Catalog, Workflows, Mission, Audit, Approvals,
   Deploy, Chat) remain in the repo and reachable to operators via their routes/components — the same
   treatment #122 gave Review/Run/Usage — but they are no longer product chrome. `ipop.ai` opens straight
   onto the board on login.

2. **Left pane = pure Projects → sessions.** `StandupPanel` dropped its Board/Reports/History view-nav.
   It is now wordmark → Projects (with the ≔ "only what needs you" filter) → expandable project rows →
   session rows in the shared status grammar. There is no Reports/History surface in v5; the founder/spend
   data still feeds the header gauge (the honest closest seam), it just no longer has its own tab.

3. **Center = exactly three columns: Work in progress / Approval needed / Done.** The column titles are the
   only board copy; they live in `CONSOLE.columns`. Department appears **only** as the card's 3px left
   edge (`--hue`), never a filled shape or a text badge.

4. **One drawer is the single "dive in" surface.** Clicking any card *or* session row slides in
   `PeekDrawer`: a "What it's doing" step trail (the real channel transcript — nothing fabricated), a
   "why did it do this? →" link that flips in place to the audit receipts we actually hold, a composer to
   steer, and — for an Approval-needed task — the ask line plus an **Approve / Not yet** pair. The board's
   approval cards carry only the ask line; the decision moved into the drawer (matching the mockup).

5. **The #13 gate is never weakened.** Approve / Not yet call `store.decideApprove` / `store.decideReject`
   — the same reconciled-against-the-server path as before. The drawer raises intent only; it holds no
   authority and invents no data. A unit test (`ConsoleView.test`) proves the drawer's Approve goes
   through `store.decideApprove`, never a shortcut.

6. **The few off-board surfaces that must stay reachable open as overlays, not tabs.** Account utilities
   (Settings → Connect-Claude/Slack #68/#170, and Sign out) live in the left-panel footer; the trial
   paywall (#153) still nudges to a pricing overlay. These are full-bleed overlays summoned on demand, so
   the resting state stays two clean panes.

7. **Copy stays in `brand.ts`; motion stays reduced-motion gated.** New copy lives under `CONSOLE.columns`,
   `CONSOLE.peek` (drawer), and `CONSOLE.shell` (footer utilities). `brand.test.ts` scans the console
   components for hardcoded brand strings and asserts the exact v5 column titles + drawer/shell copy. All
   motion (drawer slide, card swell, braille spinner, confetti) is gated behind `prefers-reduced-motion`
   in the leaf components — one gate, as before.

## Consequences

- **Simpler product, fewer surfaces to keep honest.** One board, one drawer, one status grammar. The
  cognitive load of an eleven-tab strip is gone.
- **Chat + the mentions inbox are off-chrome in v5.** With no Chat tab to navigate to, the mentions-inbox
  popover (#168) is no longer surfaced; the @mention server feature is untouched and the data
  (`unreadMentions`) still flows for a future surface. Tests that reached panels through the old nav
  (DeployPanel, Workspace) now render those panels directly or assert the nav's absence.
- **Reports/History are not a v5 surface.** The founder/spend seam still powers the header; the standalone
  brief view is dropped from the chrome (the component remains).
- **No migration, no server change.** This is web-chrome only. No new endpoints, no schema, no new
  mutation paths — the gate, the seams, and the data model are all unchanged.
- **Risk:** an operator who relied on a nav tab (e.g. Pricing, Founder) must now reach it via an overlay or
  a route. Mitigated by keeping the components and routes, and by surfacing Settings + Pricing as overlays.

## Verification

- `tsc --noEmit`, `eslint .`, `vite build`, and the web suite (325 tests) are green.
- New/updated tests: `PeekDrawer.test` (steps → why → audit toggle; Approve/Not yet raise intent; composer
  sends), `ConsoleView.test` (three v5 lanes; approve through the #13 gate *from the drawer*),
  `Workspace.test` (opens on the two-pane console; the old tab strip is absent; footer utilities present),
  `brand.test` (exact v5 column titles + drawer/shell copy; no hardcoded brand strings in the console
  components).
- Visual proof captured via the dev gallery (`/gallery/gallery.html`): the board (left projects→sessions,
  three columns, `$1.70 / $5.00` gauge, edge-only department hues) and the approval drawer (What it's
  doing / why-link / Approve · Not yet / steer composer). The gallery's fake backend gained founder-console
  + mission-control + approvals stubs so the console renders representative data.
