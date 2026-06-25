# Gallery — dev-only screenshot harness (#145)

A throwaway harness for capturing before/after shots of the product surfaces (Chat, Approvals,
Pricing, Login) without a running backend. It seeds a **real** store with a hand-rolled fake API, so
the actual components render with representative data.

It is **not** part of the product build: it lives outside `src/`, so `tsconfig` (typecheck) and
`vite build` (prod bundle) ignore it. It is served only by the dev server.

## Use

```bash
pnpm dev                       # vite dev server (default :5173)
# then open one surface (full reload required between hashes — it reads the hash once on load):
#   /gallery/gallery.html#chat       (default)
#   /gallery/gallery.html#approvals
#   /gallery/gallery.html#pricing
#   /gallery/gallery.html#login
```

`screenshots/before` and `screenshots/after` hold the captures embedded in the #145 PR.

## Visual Verification (#1072)

The screenshot evidence gate is dependency-free: it reads the PNGs listed in the visual-match manifest,
verifies they are nonblank captures at the expected size, and can compare a new candidate capture to a
reference when a target adds a candidate file.

~~~bash
pnpm visual:verify
~~~

Live production reachability is intentionally opt-in so normal CI does not depend on ipop.ai:

~~~bash
pnpm visual:verify -- --live
~~~

When refreshing a surface, capture the new screenshot from the gallery or live route, add it as the target's
candidate, and keep maxRms / maxDiffPct at zero unless the PR documents why a small tolerance is necessary.
