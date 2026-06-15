# @reload/web

The Reload web client — a Slack-style, **agent-first** workspace (issue #18). React 19 + Vite +
strict TypeScript. It consumes the server's REST + WebSocket API as-is; it makes no server calls
other than the documented contract (`platform/.context/api-contract.md`).

## Run locally

```bash
# from platform/ — start Postgres + Redis, migrate, run the server
docker compose up -d
pnpm --filter @reload/server db:migrate
pnpm --filter @reload/server dev          # http://localhost:3000

# then the web client (proxies REST + /ws to :3000 so the httpOnly rid cookie works)
pnpm --filter @reload/web dev             # http://localhost:5173
```

Point the proxy at a different API origin with `VITE_API_ORIGIN` (default `http://localhost:3000`).

## Test / gates

```bash
pnpm --filter @reload/web test            # vitest (jsdom + Testing Library)
pnpm --filter @reload/web typecheck
pnpm --filter @reload/web build           # tsc --noEmit && vite build && prerender
```

## SEO / prerendering (#252)

The public marketing surfaces are **prerendered to static HTML** at build time so crawlers (and a raw
`curl`) get the real headline + sections instead of an empty `<div id="root">`. `pnpm build` runs, after
the normal client build:

```
vite build --ssr src/entry-server.tsx --outDir dist-ssr   # SSR bundle of the marketing pages
node scripts/prerender.mjs                                  # injects bodies into the built shell
```

This writes `dist/index.html` (home), `dist/blog/**/index.html`, `dist/sitemap.xml`, and `dist/robots.txt`.
The browser still loads the full SPA on top (createRoot replaces the static markup), so the interactive
experience is unchanged. Override the canonical origin for previews with `SITE_ORIGIN` (default
`https://ipop.ai`). The HTML/XML generation is pure + unit-tested in `src/blog/seo.ts`.

The **blog** lives at `/blog`. Posts are committed markdown under `content/blog/*.md` (frontmatter +
body) — fleet agents (Scout/Quill) add an article by dropping a new file; the next build prerenders and
lists it. See `src/blog/`.

## Architecture (one store, no router)

```
src/
  api/        types.ts (wire contract) · client.ts (REST) · realtime.ts (/ws, reconnect+resubscribe)
  store/      store.ts (useSyncExternalStore) · StoreContext.tsx · mentions.ts (@-autocomplete)
  components/ AuthGate · Workspace · ChannelSidebar · MessagePane · Composer · ThreadPanel · MembersRail
```

State lives in one in-memory store exposed via `useSyncExternalStore`. Realtime `message`/`mention`/
`presence` events and REST responses are reconciled in the store (dedup by message id). See
`platform/docs/adrs/0018-web-client.md` for the decisions and the known server constraints adapted to.
