import { fingerprintFailure, type Fingerprint } from "../flywheel/fingerprint.js";
import type { VoiceCategory } from "../voice/classify.js";
import type { SupportDeskCaps } from "./caps.js";

/**
 * Recurring-complaint detection for the Support Desk (#190, ADR-0190) — **pure**, reusing the #117
 * flywheel fingerprint. A complaint is fingerprinted on its `customer_complaint` class + a normalized
 * "category: body" message, so the same *shape* of complaint from many customers collides to one stable
 * signature (the dedup key behind the backlog issue). Once a signature crosses
 * `recurringComplaintThreshold`, the IO layer files/reopens exactly ONE deduped backlog issue via the
 * #117/#171 GitHub seam (AC4 — "recurring complaints auto-file issues into the venture backlog").
 *
 * One isolated complaint is noise, not a backlog item — the threshold is what turns a stream of voices
 * into a single actionable issue.
 */
export interface ComplaintInput {
  category: VoiceCategory;
  subject: string | null;
  body: string;
}

/** Fingerprint a complaint into the stable signature + a backlog-issue title. Pure + deterministic. */
export function fingerprintComplaint(input: ComplaintInput): Fingerprint {
  const head = (input.subject ?? input.body).trim();
  return fingerprintFailure({
    failureClass: "customer_complaint",
    message: `${input.category}: ${head}`,
  });
}

/**
 * Whether this fingerprint's running count has reached the threshold for filing a backlog issue. The IO
 * layer dedupes the issue itself (one-per-fingerprint via the #108 label-marker), so this only gates the
 * "is it recurring yet?" question. `>=` so a threshold of 1 files on the first complaint if a deployment
 * really wants that.
 */
export function shouldFileComplaintIssue(countForFingerprint: number, caps: SupportDeskCaps): boolean {
  return countForFingerprint >= caps.recurringComplaintThreshold;
}
