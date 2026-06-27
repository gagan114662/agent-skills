# Web Deploy Freshness Runbook

Use this when `https://ipop.ai/` still shows old homepage copy after a web-facing PR merges, or when the `web-deploy-freshness` workflow fails.

## What The Check Proves

The public homepage must carry a prerendered build stamp:

```html
<meta name="reload-build-sha" content="<git-sha>" />
```

The freshness probe fetches `https://ipop.ai/` without executing JavaScript and fails when:

- the build stamp is missing;
- the live stamp does not match the expected main commit;
- the current homepage contract is absent: `Make marketing pop.` and `marketing team in your messages`;
- stale homepage copy is still present: `The marketing agency of AI agents`, `Start free`, or `Watch live demo`.

## Manual Probe

From `platform/`:

```bash
EXPECTED_WEB_SHA="$(git rev-parse origin/main)" pnpm --filter @reload/web deploy:freshness
```

For a specific commit or preview target:

```bash
EXPECTED_WEB_SHA="<sha>" PRODUCTION_WEB_URL="https://ipop.ai/" pnpm --filter @reload/web deploy:freshness
```

## If Vercel Is Rate Limited

1. Confirm the failure is a deploy freshness issue, not an app build issue:

```bash
gh api "repos/gagan114662/agent-skills/commits/$(git rev-parse origin/main)/status" \
  --jq '.statuses[] | select(.context == "Vercel") | {state, description, target_url}'
```

2. If the status says `Deployment rate limited`, do not close the product issue as fixed. Leave the deploy-freshness issue open until production passes the manual probe.

3. Retry from Vercel when quota resets, or use the Vercel dashboard suggested by the failing status target. After retrying, rerun:

```bash
EXPECTED_WEB_SHA="$(git rev-parse origin/main)" pnpm --filter @reload/web deploy:freshness
```

4. Only call the production homepage fixed when the command exits 0 and the live root no longer contains the stale copy.

## Expected Recovery Signal

A recovered deploy prints:

```text
production fresh: https://ipop.ai/ is on <sha>
```
