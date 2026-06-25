export interface SignupAttribution {
  source: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  trackingRef: string | null;
  referralCode: string | null;
}

const TRACKING_REF_RE = /^[A-Za-z0-9_-]{1,80}$/;
const REFERRAL_CODE_RE = /^[A-Za-z0-9_-]{3,80}$/;

function clean(value: unknown, max = 120): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const cleaned = clean(value);
    if (cleaned.length > 0) return cleaned;
  }
  return "";
}

export function attributionMetadata(input: SignupAttribution): Record<string, unknown> {
  return {
    ...(input.utmSource ? { utmSource: input.utmSource } : {}),
    ...(input.utmMedium ? { utmMedium: input.utmMedium } : {}),
    ...(input.utmCampaign ? { utmCampaign: input.utmCampaign } : {}),
    ...(input.trackingRef ? { trackingRef: input.trackingRef } : {}),
  };
}

export function readSignupAttribution(input: {
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
}): SignupAttribution {
  const body = input.body ?? {};
  const query = input.query ?? {};
  const utmSource = firstString(body.utmSource, body.utm_source, query.utmSource, query.utm_source);
  const utmMedium = firstString(body.utmMedium, body.utm_medium, query.utmMedium, query.utm_medium);
  const utmCampaign = firstString(
    body.utmCampaign,
    body.utm_campaign,
    query.utmCampaign,
    query.utm_campaign,
  );
  const source = firstString(body.source, query.source, utmSource);
  const rawRef = firstString(body.trackingRef, body.ref, query.trackingRef, query.ref);
  const rawReferralCode = firstString(
    body.referralCode,
    body.referral_code,
    body.referral,
    query.referralCode,
    query.referral_code,
    query.referral,
  );
  return {
    source,
    utmSource,
    utmMedium,
    utmCampaign,
    trackingRef: TRACKING_REF_RE.test(rawRef) ? rawRef : null,
    referralCode: REFERRAL_CODE_RE.test(rawReferralCode) ? rawReferralCode : null,
  };
}
