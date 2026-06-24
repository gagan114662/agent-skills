---
title: Why client-rendered sites look empty to Google
slug: why-client-rendered-sites-are-invisible-to-google
description: Learn why search crawlers may see an empty page on client-rendered sites, how to diagnose it, and the fastest SSR-friendly fix.
author: scout
date: 2026-06-14
status: published
---

# Why a client-rendered site shows up empty to Google

A search crawler doesn't run your app the way a person does. The first thing it asks for is the raw HTML
at your URL — and for a lot of modern sites, that raw HTML is almost empty:

```
<!doctype html>
<html>
  <head> ...meta tags... </head>
  <body><div id="root"></div></body>
</html>
```

All the real content — the headline, the sections, the proof — gets drawn *later*, by JavaScript, in the
visitor's browser. That's "client-side rendering." Humans see a full page. A crawler that doesn't wait
for (or run) your JavaScript sees an empty `<div id="root">`. No headline, no body, nothing to index.

## How Scout diagnoses it in ten seconds

The single most useful check is a raw fetch — exactly what a crawler does first:

```
curl -s https://yoursite.com | grep -i "<h1"
```

If that returns nothing, your headline isn't in the HTML. Then:

- **`site:yoursite.com` in Google.** Zero results means nothing is indexed yet.
- **No `sitemap.xml` or `robots.txt`.** Crawlers can still find you, but you're making them guess.
- **One giant JavaScript bundle, tiny HTML.** The tell-tale shape of a client-rendered app.

## Why it happens (it's not a bug)

Client-side rendering is a perfectly good way to build an *app*. The problem is using it for a
*marketing page* — the one surface whose entire job is to be found. The fix isn't to rewrite the app. It's
to make sure the public pages ship their content in the HTML.

## The fix that doesn't touch your design

You have three honest options, cheapest first:

1. **Prerender at build time.** Render the marketing pages to static HTML once, during the build, and
   serve that. The browser still hydrates the full interactive app on top — visitors get the exact same
   experience, crawlers get real text. No design change, no server to run.
2. **Server-side render (SSR).** Render every request on a server. More moving parts; worth it when
   content changes per-request.
3. **Dynamic rendering.** Detect crawlers and serve them a prerendered copy. A legitimate bridge, but one
   more thing to maintain.

For a marketing site, **prerendering wins almost every time**: it's the simplest, it can't drift from
what humans see, and it turns a blank page into a fully indexable one.

## The checklist

- A raw `curl` of every public page returns the real headline and section text.
- `robots.txt` exists and points at your sitemap.
- `sitemap.xml` lists every indexable URL.
- You've verified the domain in Google Search Console and submitted the sitemap — a one-time human step.

Get those four right and "site:yoursite.com returns zero pages" becomes a number that only goes up. That
first indexed page is the proof everything else is built on.
