---
title: How AI agents run an SEO audit (and where humans still decide)
slug: how-ai-agents-run-an-seo-audit
description: A practical, honest walkthrough of how an AI agent audits a website for SEO — what it can read like a crawler, what it can only flag, and the exact points where a human still has to make the call.
kind: guide
agent: scout
date: 2026-06-11
status: published
order: 1
---

# How AI agents run an SEO audit (and where humans still decide)

Most "AI SEO" pitches skip the boring truth: a lot of an audit is mechanical, an agent is genuinely good
at the mechanical part, and the judgement still belongs to you. This guide walks the whole loop the way
our SEO agent, Scout, actually runs it — so you can run it too, with or without us.

## Step 1 — Read the page the way a crawler does

A search crawler doesn't see your design; it sees structure. An agent reads the same things:

- **The title tag and meta description.** Present? Unique per page? Under the length where search
  engines truncate them (~60 chars for titles, ~155 for descriptions)?
- **One `h1`, then a sane heading outline.** Crawlers infer topic structure from `h1` → `h2` → `h3`.
  Skipped levels and multiple `h1`s muddy the signal.
- **Alt text on images.** Missing alt text is both an accessibility miss and a lost ranking signal.
- **Internal links.** Orphan pages (nothing links to them) are pages search engines struggle to find.

An agent can scan every page for these in seconds. This is the part to automate without guilt.

## Step 2 — Check the technical fundamentals

- **Crawlability:** is there a `robots.txt` that accidentally blocks something important? A `sitemap.xml`
  that's actually current?
- **Canonical tags:** are duplicate URLs pointing at one canonical version?
- **Page speed signals:** large unoptimised images, render-blocking scripts. An agent can flag the
  offenders; fixing them is an engineering decision.

## Step 3 — Map intent, not just keywords

Here's where it gets less mechanical. For each important page, ask: **what is the person who lands here
actually trying to do?** An agent can draft a keyword-to-intent map and suggest where your content
answers the question and where it dodges it. But whether that intent matches your *business* — that's
your call.

## Step 4 — Prioritise ruthlessly

A raw audit returns fifty issues. Most don't matter. The agent's real job is to rank them:

1. **Bugs that hide pages from search** (a stray `noindex`, a blocked path) — fix today.
2. **Missing metadata on high-traffic pages** — fix this week.
3. **Thin or duplicate content** — plan a rewrite.
4. **Nice-to-haves** — backlog.

## Where humans still decide

- **What's worth ranking for.** An agent can tell you a keyword is winnable; only you know if it's
  *worth winning*.
- **Brand voice in the rewrite.** The agent drafts; you make sure it still sounds like you.
- **Anything that publishes.** A good setup gates every change behind a human approval — drafts land
  first, you ship the fixes you trust.

## The loop, in one line

The agent reads the structure, flags the issues, ranks them, and drafts the fixes. You decide what's
worth doing and what's allowed to go live. That division — machine does the volume, human keeps the
judgement — is the whole game.

Want Scout to run this on your site? Start free and brief it in one line.
