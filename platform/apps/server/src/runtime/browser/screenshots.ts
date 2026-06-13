/**
 * Screenshot store seam (#174, ADR-0174). A browser step's screenshot is a deliverable attachment + a
 * receipt; storing it is an IO concern kept behind a seam so the session stays unit-testable. The
 * default in-memory store returns a stable, scrubbed path (never a token-bearing URL) and keeps the
 * bytes so a test can assert the stream. A production store would write to object storage / disk.
 */
export interface ScreenshotStore {
  put(input: { sessionId: string; stepNo: number; base64: string }): Promise<string>;
}

export interface InMemoryScreenshotStore extends ScreenshotStore {
  readonly stored: Map<string, string>;
}

export function inMemoryScreenshotStore(): InMemoryScreenshotStore {
  const stored = new Map<string, string>();
  return {
    stored,
    async put({ sessionId, stepNo, base64 }): Promise<string> {
      const path = `screenshots/${sessionId}/step-${stepNo}.png`;
      stored.set(path, base64);
      return path;
    },
  };
}
