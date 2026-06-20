---
name: email-deliverability
kind: reference
domain: email
description: Protecting the inbox — SPF/DKIM/DMARC in plain terms, domain warming, list hygiene, RFC 8058 one-click unsubscribe, complaint/bounce thresholds, and concrete anti-spam practices.
---

# Deliverability

Deliverability is whether the mailbox provider (Gmail, Outlook, Yahoo) puts your mail in the inbox, the spam folder, or rejects it outright. It is earned through authentication + reputation + list quality, and it is lost in days but rebuilt in weeks. The single most predictive factor is *do recipients want this mail* — everything below protects that signal.

## Authentication: SPF, DKIM, DMARC (plain terms)

These three DNS records prove an email is really from you. Gmail and Yahoo **require** all three for bulk senders (>5,000/day) — without them you're rejected or junked.

- **SPF** (Sender Policy Framework) — a DNS TXT record listing which servers/IPs are allowed to send for your domain. The receiver checks: did this come from an authorized sender? Answers "is this server allowed to send as us?"
- **DKIM** (DomainKeys Identified Mail) — a cryptographic signature added to each message; the receiver fetches your public key from DNS and verifies the body/headers weren't tampered with in transit and were signed by your domain. Answers "is this really from us and unaltered?"
- **DMARC** (Domain-based Message Authentication, Reporting & Conformance) — the policy that ties SPF+DKIM to your visible From: domain (alignment) and tells receivers what to do on failure: `p=none` (monitor), `p=quarantine` (spam folder), `p=reject` (drop). Start at `p=none` with a `rua=` reporting address, read the reports, then tighten to quarantine/reject. Answers "what should you do if auth fails, and where do I get reports?"

## Verified sending domain

Send from your **own authenticated domain** (mail.yourbrand.com), not a generic ESP-shared "from", and never from a free address (`@gmail.com`) as the From: — DMARC at the big providers will reject it. Use a dedicated **subdomain** for marketing (e.g. `news.yourbrand.com`) so promotional reputation never contaminates transactional/corporate mail.

## Domain & IP warming

A brand-new domain or IP has no reputation; blasting 100k cold sends day one looks exactly like a spammer and gets you blocked. **Warm up**: start at ~50–100/day to your most-engaged recipients, then roughly double every 2–3 days over 4–6 weeks, watching opens/complaints at each step. Engaged opens early teach providers you're wanted.

## List hygiene — only mail people who asked

- **Permission only.** Mail people who opted in. Never buy/scrape lists — one purchased list can tank a domain permanently.
- **Confirm/double opt-in** for risky sources; **verify** addresses at capture (syntax + MX) to cut typos and traps.
- **Sunset inactive recipients.** If someone hasn't opened/clicked in ~60–90 days, run a re-engagement pass, then **suppress** non-responders. Mailing dead addresses lowers engagement rate (a ranking signal) and risks **spam traps** — recycled or pristine addresses that exist only to catch senders who don't clean lists.
- **Honor unsubscribes instantly** and process bounces every send.

## One-click unsubscribe (RFC 8058)

Required by Gmail/Yahoo for bulk senders. Add the `List-Unsubscribe` header **and** `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, so the provider shows a native "Unsubscribe" button that opts the user out via a single POST — no landing page, no login. A frictionless unsubscribe is *better* than a buried one: it diverts people who'd otherwise hit "Report spam," which is far more damaging than a clean opt-out. Keep a visible footer unsubscribe link too.

## Thresholds to watch

- **Spam-complaint rate**: keep **< 0.1%** (1 in 1,000). **0.3%** is Gmail's red line — sustained complaints above it get you junked or blocked. Investigate anything above 0.1%.
- **Hard-bounce rate**: keep **< 2%** per send; spikes signal a stale or purchased list. Remove hard bounces permanently after one failure.
- **Soft bounces**: retry, then suppress after several consecutive failures.
- **Engagement (opens/clicks)**: trending down predicts inbox placement decline before complaints do — treat it as an early warning.

## Practices that keep you out of spam

- Maintain a healthy text-to-image ratio; an all-image email with one giant graphic is a classic spam pattern. Every image needs alt text.
- Don't link to shady/blocklisted domains or bare URL shorteners; use your authenticated domain for click-tracking.
- Send consistent volume on a predictable cadence — erratic spikes look like compromise.
- Monitor blocklists and DMARC `rua` reports; act on a reputation dip the same day.

made by robots, steered by humans.
