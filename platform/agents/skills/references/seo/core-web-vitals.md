---
name: seo-core-web-vitals
kind: reference
domain: seo
description: Core Web Vitals deep reference — LCP, INP, CLS thresholds, top real causes, specific fixes, and how to measure (field vs lab, CrUX, Lighthouse).
---

# Core Web Vitals

CWV is a real (if light) ranking signal and a heavy conversion signal. Google grades the **75th percentile** of **field** traffic per metric, segmented by mobile/desktop. A URL group passes only when all three are "Good" at p75. Optimize for the field number, not the lab score.

## The three metrics, thresholds, causes, fixes

### LCP — Largest Contentful Paint (loading)
When the largest above-the-fold element (usually the hero image, a `<video>` poster, or a big text block) renders.
- **Good ≤ 2.5s · Needs work 2.5–4.0s · Poor > 4.0s** (p75)
- **Top causes**: (1) slow TTFB — server/origin latency, no CDN, no caching; (2) render-blocking CSS/JS in `<head>`; (3) the LCP image is large, lazy-loaded, or discovered late by the preload scanner; (4) the resource isn't prioritized.
- **Fixes**: serve the LCP image as `fetchpriority="high"`, **never** `loading="lazy"` on it; `<link rel="preload">` it; use AVIF/WebP + responsive `srcset`; put TTFB under ~800ms (CDN, edge cache, faster DB); inline critical CSS and `defer`/`async` non-critical JS; self-host fonts with `font-display: swap` + preload. LCP breaks into TTFB + resource load delay + load time + render delay — measure which dominates before fixing.

### INP — Interaction to Next Paint (responsiveness)
Replaced FID in March 2024. Measures the *worst* (near-worst) latency from a user interaction (tap/click/keypress) to the next visual update, across the whole visit.
- **Good ≤ 200ms · Needs work 200–500ms · Poor > 500ms** (p75)
- **Top causes**: (1) long JS tasks blocking the main thread (> 50ms) so input can't be processed; (2) heavy hydration / large bundles on a SPA; (3) expensive event handlers doing synchronous work; (4) large DOM (rendering/style recalc cost).
- **Fixes**: break long tasks with `await scheduler.yield()` or `setTimeout`/`requestIdleCallback`; code-split and lazy-load JS (ship less); debounce/throttle handlers; move heavy work to a Web Worker; reduce DOM size and avoid forced synchronous layout (reading layout right after writing it); defer third-party scripts (tag managers, chat widgets are common INP killers).

### CLS — Cumulative Layout Shift (visual stability)
Sum of unexpected layout shift scores over the page's lifespan (largest burst window).
- **Good ≤ 0.1 · Needs work 0.1–0.25 · Poor > 0.25**
- **Top causes**: (1) images/videos/iframes without explicit `width`/`height` (or `aspect-ratio`); (2) ads, embeds, banners injected without reserved space; (3) web fonts causing FOIT/FOUT reflow; (4) content inserted above existing content (cookie bars, "you may also like"); (5) actions that animate `top`/`left`/`height` instead of `transform`.
- **Fixes**: always set `width` and `height` (or CSS `aspect-ratio`) on media; reserve fixed slots (`min-height`) for ads/embeds/late content; preload fonts and use `size-adjust`/`font-display: optional` to cut reflow; only animate `transform` and `opacity`; never inject DOM above the fold after load.

## How to measure — field vs lab

- **Field (real users, what Google ranks on)**: CrUX (Chrome User Experience Report) is the source of truth — 28-day rolling p75 from real Chrome users. Read it via **GSC → Core Web Vitals** (URL-group trends, your primary monitor), **PageSpeed Insights** (per-URL field + lab), or the **CrUX API/Dashboard** for raw data. Best of all: your own **RUM** with the `web-vitals` JS library reporting real INP/LCP/CLS per session — field data is the only thing that counts toward ranking.
- **Lab (synthetic, for debugging)**: **Lighthouse** / DevTools / PageSpeed lab give a repeatable score and a waterfall to find *why* — but lab can't measure INP (no real interactions; it reports Total Blocking Time as a proxy) and runs one cold load, so it often disagrees with field. Use lab to diagnose and iterate; **validate every fix against the field number 28 days later.**

**Workflow**: GSC flags a failing URL group → PSI/Lighthouse on a representative URL to find the dominant cause → ship the targeted fix → watch CrUX p75 recover. Don't chase the lab "performance score" — chase passing p75 on all three.

made by robots, steered by humans.
