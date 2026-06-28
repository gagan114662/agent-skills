# Connection OAuth Runbook

Issue #1285 closes only when the owner workspace can complete real OAuth consent flows and read back live
provider status. Code presence is not enough.

## Doctor

Run the safe setup doctor from the repo root:

    pnpm -C platform --filter @reload/server oauth:doctor

The doctor reports missing env vars by name only. It does not print client secrets, exchange codes, or call
provider token endpoints. It verifies that the server would select a live OAuth provider for:

- Google Search Console / Analytics
- Google Ads
- X
- Meta Ads
- LinkedIn

## Required Production Env

Google Search Console / Analytics:

- GOOGLE_OAUTH_CLIENT_ID
- GOOGLE_OAUTH_CLIENT_SECRET
- GOOGLE_CONNECTION_OAUTH_REDIRECT_URI

Google Ads:

- GOOGLE_OAUTH_CLIENT_ID
- GOOGLE_OAUTH_CLIENT_SECRET
- GOOGLE_ADS_CONNECTION_OAUTH_REDIRECT_URI

X:

- X_OAUTH_CLIENT_ID
- X_OAUTH_CLIENT_SECRET
- X_CONNECTION_OAUTH_REDIRECT_URI

Meta Ads:

- META_OAUTH_CLIENT_ID
- META_OAUTH_CLIENT_SECRET
- META_ADS_CONNECTION_OAUTH_REDIRECT_URI

LinkedIn:

- LINKEDIN_OAUTH_CLIENT_ID
- LINKEDIN_OAUTH_CLIENT_SECRET
- LINKEDIN_CONNECTION_OAUTH_REDIRECT_URI

Google and Google Ads can derive their connection callback URLs from GOOGLE_OAUTH_REDIRECT_URI when the
dedicated connection redirect vars are absent. Provider app allowlists must still include the derived
connection callback URLs shown by the doctor.

## Proof Before Closure

- oauth:doctor passes all configured target providers.
- Production /me/connections shows the provider as available, not coming_soon.
- Owner completes the real OAuth consent flow for each target provider.
- Callback seals provider credentials into the connection vault without exposing secrets.
- /me/connections readback shows connected status and provider capabilities for the owner workspace.
- A downstream marketing action proves the connected provider is usable, or the issue remains open with the
  provider-specific app-review/access blocker named explicitly.
