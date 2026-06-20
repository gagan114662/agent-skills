---
name: analytics-raw-fallback-protocol
kind: reference
domain: analytics
description: Protocol for reporting honestly when only raw or ad-hoc data is available — flagging, vanity-metric defense, and the one-number/one-action close.
---

# Raw Fallback Protocol

Sometimes the governed semantic layer and curated tables are unavailable and all
you have is a hand-pulled export, an API call, or a screenshot. That is allowed —
but it changes how you must report. The cardinal sin is laundering ad-hoc data
into a confident headline. This protocol keeps raw numbers honest.

## Step 1 — Flag every unverified figure

Mark any figure not sourced from the semantic layer or a curated table with an
explicit tag inline, e.g. `[unverified]` or `[raw fallback]`. Never let an
unverified number sit next to a governed one without a label — the reader cannot
tell load-bearing numbers from scaffolding otherwise. If the whole report is on
raw data, say so in the first line.

## Step 2 — Cite provenance and freshness

Every raw figure carries three facts, stated next to it:

- **Source** — exactly where it came from ("Stripe dashboard, Payments view",
  "GA4 export pulled via API", "screenshot from the ad console"). "From
  analytics" is not a source.
- **As-of timestamp** — when the data was captured *and* the period it covers.
  Stale data is a wrong answer with a confident tone. A weekend-only window
  silently inflates or deflates almost everything.
- **Method** — how it was counted, including the definition (numerator,
  denominator, window). If you summed a CSV column, say which column and whether
  duplicates or test rows were removed.

If you cannot supply all three, downgrade the claim to "directional only."

## Step 3 — Hunt and kill vanity metrics

Vanity metrics go up, feel good, and change no decision. They are the natural
output of ad-hoc data because they are the easiest to pull.

The test: **"If this number doubled overnight, would any decision change?"** If
no, cut it from the report. Apply it ruthlessly.

- **Impressions / reach** — measures spend, not interest. Replace with *engaged
  sessions* or *qualified clicks*.
- **Follower count** — a stock that rarely converts. Replace with *referral
  traffic from that channel* or *attributed signups*.
- **Page views** — replace with *conversions* or *activation events*.
- **Email opens** — pixel-inflated and increasingly unmeasurable. Replace with
  *clicks → action*.
- **Total signups (cumulative)** — only goes up; tells you nothing. Replace with
  *new activated users this period* and *retention*.

Rule of thumb: prefer **rates over totals**, **cohorts over cumulative**, **net
over gross**, and **actions over impressions**. A metric you cannot tie to a
decision is theater regardless of how it was sourced.

## Step 4 — Cross-check before trusting

For any important raw number, find a second, independent path to roughly the same
figure (ad-platform clicks vs server-logged sessions; Stripe revenue vs bank
deposits). If two independent sources agree within tolerance, confidence rises.
If they diverge, report the discrepancy — do not silently pick the prettier one.

## Step 5 — Close with one number and one action

End **every** analysis with exactly two lines:

> **The one number:** *<the single metric that matters right now, with its
> provenance and unverified flag if applicable>.*
>
> **The action it implies:** *<the specific next decision or experiment>.*

If you cannot name the action a number implies, you have not finished the
analysis — or the number was vanity and should have been cut in Step 3. A report
that ends in a list of metrics with no decision is incomplete. The job is not to
display data; it is to change a decision, honestly, with a receipt behind it.

made by robots, steered by humans.
