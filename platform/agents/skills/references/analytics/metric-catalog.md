---
name: analytics-metric-catalog
kind: reference
domain: analytics
description: Canonical marketing metrics with precise definitions and the decision each one informs.
---

# Metric Catalog

A metric is only useful if it is defined identically everywhere it appears. Two
dashboards that compute "conversion rate" differently produce two different
companies. Pick one definition per metric, write it down, and never let a
second definition exist. This catalog is that single source of truth.

## North-star metric (NSM)

**Definition:** The single number that best predicts long-term value delivered to
customers — the thing that, if it grows, the business grows. Not revenue
(lagging) and not signups (shallow). Examples: nights booked (Airbnb), weekly
active teams (Slack), messages sent. It must (1) reflect real customer value,
(2) be a leading indicator of revenue, (3) be movable by the team this quarter.
**Decision it informs:** What every team prioritizes. If a proposed project does
not plausibly move the NSM, it goes to the bottom of the list.

## AARRR — the pirate funnel

One key metric per stage. Measure each as a rate, cohort it, and watch the
*transition* between stages, not the absolute counts.

- **Acquisition** — *Traffic→signup conversion rate* = new signups ÷ unique
  visitors, by channel. *Decision:* where to spend the next acquisition dollar.
- **Activation** — *Activation rate* = users who reach the "aha" event (the
  action correlated with retention, e.g. "invited a teammate within 24h") ÷
  signups. *Decision:* what to fix in onboarding. This is usually the highest-
  leverage stage and the most ignored.
- **Retention** — *Nth-period retention* = users active in period N ÷ users in
  the cohort's period 0. Plot the full curve; a flattening curve (not zero)
  means product–market fit. *Decision:* whether to pour fuel (growth) or fix
  the bucket (retention) first. Never scale acquisition over a leaky bucket.
- **Revenue** — *MRR / ARR* (below) and **ARPU** = revenue ÷ active users.
  *Decision:* pricing and packaging.
- **Referral** — *K-factor* = invites sent per user × invite acceptance rate.
  K>1 = viral growth. *Decision:* whether referral is a real channel or theater.

## Unit economics

- **CAC** — Customer Acquisition Cost = (total sales + marketing spend in a
  period) ÷ new customers acquired *in the same period and channel*. Include
  salaries and tooling, not just ad spend. *Decision:* is a channel affordable.
- **LTV** — Lifetime Value = ARPU × gross margin % × average customer lifetime
  (where lifetime ≈ 1 ÷ churn rate). Use *gross* margin, not revenue. *Decision:*
  the ceiling on what you can pay to acquire a customer.
- **LTV:CAC ratio** — health gauge. <1 = losing money per customer; ~3 = healthy;
  >5 = likely *underspending* on growth. **CAC payback** (months to recover CAC
  from gross-margin revenue) matters more than the ratio for cash-constrained
  teams; target < 12 months.

## Recurring revenue & churn

- **MRR / ARR** — Monthly / Annual Recurring Revenue = sum of normalized monthly
  subscription value of active paying customers (ARR = MRR × 12). Exclude one-
  time fees. Track **Net Revenue Retention** = (start MRR + expansion −
  contraction − churn) ÷ start MRR; NRR > 100% means you grow without new logos.
- **Churn rate** — *Customer churn* = customers lost ÷ customers at period start.
  *Revenue churn* = MRR lost ÷ starting MRR (can go negative with expansion).
  Always state which. *Decision:* retention investment and the validity of every
  LTV number above.
- **Conversion rate** — *always* state numerator, denominator, and window.
  "Trial→paid conversion = paid within 30 days ÷ trials started" is a metric;
  "conversion rate" alone is a guess.

## The ONE metric that matters this week (OMTM)

Even with all of the above, focus on a single constraining metric for the
current stage. Find the stage in the funnel with the worst transition rate or
the steepest leak — that is the constraint. Set one target, one window, one
owner. Everything else is monitored, not optimized. When the constraint moves,
the OMTM changes. Reporting ten equal metrics is the same as reporting none.

made by robots, steered by humans.
