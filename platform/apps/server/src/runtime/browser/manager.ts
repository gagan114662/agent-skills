/**
 * BrowserSessionManager (#174, ADR-0174) — owns the lifecycle + the isolation boundary for agent
 * browser sessions. One isolated {@link BrowserContextHandle} per session (fresh profile, no shared
 * cookies), tenant-scoped by `workspaceId`, allocated on `open` and torn down on `close` (and
 * `closeAll` on shutdown). It is the enabled-flag chokepoint: a workspace whose `[browser]` policy is
 * OFF can never open a session (it throws {@link BrowserDisabledError}), and a `sessionId` gets at most
 * one browser. Caps are resolved per workspace at open time and frozen for the session's life.
 *
 * This mirrors how {@link SessionManager} allocates per-session resources and frees them in a `finally`
 * — the manager is wired into that teardown so a browser context is released on EVERY exit path.
 */
import type { BrowserCaps } from "./caps.js";
import type { BrowserContextHandle, BrowserDriver } from "./driver.js";
import type { BrowserApprovalGate } from "./approval.js";
import type { BrowserReceiptRecorder } from "./receipts.js";
import { inMemoryReceiptRecorder } from "./receipts.js";
import type { ScreenshotStore } from "./screenshots.js";
import { inMemoryScreenshotStore } from "./screenshots.js";
import { BrowserSession } from "./session.js";

/** Thrown when a workspace whose browser policy is OFF tries to open a session. */
export class BrowserDisabledError extends Error {
  constructor(workspaceId: string) {
    super(`agent browser runtime is disabled for workspace ${workspaceId}`);
    this.name = "BrowserDisabledError";
  }
}

export interface BrowserSessionManagerDeps {
  driver: BrowserDriver;
  /** Resolve the per-workspace browser caps (production: `resolveBrowserCaps(loadConfig(wid).browser)`). */
  loadCaps: (workspaceId: string) => BrowserCaps;
  approvalGate: BrowserApprovalGate;
  receipts?: BrowserReceiptRecorder;
  screenshots?: ScreenshotStore;
  now?: () => number;
}

interface Entry {
  session: BrowserSession;
  context: BrowserContextHandle;
}

export class BrowserSessionManager {
  private readonly deps: BrowserSessionManagerDeps;
  private readonly receipts: BrowserReceiptRecorder;
  private readonly screenshots: ScreenshotStore;
  private readonly sessions = new Map<string, Entry>();

  constructor(deps: BrowserSessionManagerDeps) {
    this.deps = deps;
    this.receipts = deps.receipts ?? inMemoryReceiptRecorder();
    this.screenshots = deps.screenshots ?? inMemoryScreenshotStore();
  }

  /**
   * Open a browser for one session. Refuses when the workspace's policy is OFF, or when a browser is
   * already open for this `sessionId`. Allocates a fresh isolated context + page (the tenant boundary).
   */
  async open(input: { sessionId: string; workspaceId: string }): Promise<BrowserSession> {
    const caps = this.deps.loadCaps(input.workspaceId);
    if (!caps.enabled) throw new BrowserDisabledError(input.workspaceId);
    if (this.sessions.has(input.sessionId)) {
      throw new Error(`a browser is already open for session ${input.sessionId}`);
    }
    // Allocate the isolated context + page. If `newPage` (or the session build) throws after the
    // context exists, close the context first so a failed open never leaks a live browser context.
    const context = await this.deps.driver.newContext(input);
    let session: BrowserSession;
    try {
      const page = await context.newPage();
      session = new BrowserSession({
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        caps,
        context,
        page,
        approvalGate: this.deps.approvalGate,
        receipts: this.receipts,
        screenshots: this.screenshots,
        now: this.deps.now,
      });
    } catch (err) {
      await context.close().catch(() => {}); // best-effort: never mask the original error
      throw err;
    }
    this.sessions.set(input.sessionId, { session, context });
    return session;
  }

  get(sessionId: string): BrowserSession | undefined {
    return this.sessions.get(sessionId)?.session;
  }

  /** Close one session's browser — closes the page + the isolated context (frees the profile). */
  async close(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    await entry.session.close();
    await entry.context.close();
  }

  /** Tear down every live session (shutdown / drain). One session's teardown failure never blocks the rest. */
  async closeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.allSettled(ids.map((id) => this.close(id)));
  }

  get openCount(): number {
    return this.sessions.size;
  }
}
