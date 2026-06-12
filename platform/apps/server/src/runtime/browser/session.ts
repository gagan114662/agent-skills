/**
 * BrowserSession (#174, ADR-0174) — one agent's live, isolated Chromium, exposed as the seven tools
 * (navigate / read_page / screenshot / scroll / wait / click / type). Every tool call funnels through
 * one private `step()` that:
 *   1. asks the pure {@link decideBrowserStep} gate (caps + domain lists + side-effect classification);
 *   2. for a side-effectful step with no approval, asks the {@link BrowserApprovalGate} — and REFUSES
 *      the action when it is not yet approved (a #13 request is raised; the agent retries after a human
 *      acts). The driver is never touched on a refusal;
 *   3. performs the action via the {@link BrowserDriver}, updates the per-session usage counters
 *      (pages / bytes / wall-clock), captures a screenshot, and records a receipt — for EVERY step.
 *
 * The session never enforces policy itself beyond calling the gate: all the rules live in the pure
 * decider, so the safety posture is testable end-to-end without a browser. It holds exactly one page in
 * one context; the context is owned + torn down by the {@link BrowserSessionManager}.
 */
import {
  decideBrowserStep,
  type BrowserDecisionKind,
  type BrowserUsage,
} from "./decide.js";
import type { BrowserCaps } from "./caps.js";
import type { BrowserContextHandle, BrowserPageHandle, BrowserPageSnapshot } from "./driver.js";
import type { BrowserApprovalGate } from "./approval.js";
import type { BrowserReceiptRecorder } from "./receipts.js";
import type { ScreenshotStore } from "./screenshots.js";
import { browserToolSpec, type BrowserToolName } from "./tools.js";

/** The outcome the tool surface relays back to the agent. `ok:false` ⇒ the action did NOT run. */
export interface BrowserStepResult {
  ok: boolean;
  tool: BrowserToolName;
  decision: BrowserDecisionKind;
  reason: string;
  url: string | null;
  approvalRequestId: string | null;
  screenshotPath: string | null;
  /** read_page payload. */
  page?: BrowserPageSnapshot;
  /** navigate payload. */
  status?: number;
  /** screenshot payload (base64). */
  screenshot?: string;
}

export interface BrowserSessionDeps {
  sessionId: string;
  workspaceId: string;
  caps: BrowserCaps;
  context: BrowserContextHandle;
  page: BrowserPageHandle;
  approvalGate: BrowserApprovalGate;
  receipts: BrowserReceiptRecorder;
  screenshots: ScreenshotStore;
  /** Injectable clock so wall-clock caps are deterministically tested. Defaults to `Date.now`. */
  now?: () => number;
}

interface StepRequest {
  tool: BrowserToolName;
  /** The action's URL target (navigate) — falls back to the current page URL for the denylist re-check. */
  target?: string;
  credentialEntry?: boolean;
  captcha?: boolean;
  detail: string;
  /** Performs the side effect + returns the screenshot-able state. Only called on an `allow`. */
  perform: () => Promise<{ bytes: number; status?: number; page?: BrowserPageSnapshot; consumesPage: boolean }>;
}

export class BrowserSession {
  private readonly deps: BrowserSessionDeps;
  private readonly now: () => number;
  private readonly startedAt: number;
  private pages = 0;
  private bytes = 0;
  private stepNo = 0;
  private closed = false;

  constructor(deps: BrowserSessionDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.startedAt = this.now();
  }

  get id(): string {
    return this.deps.sessionId;
  }

  /** A read-only view of what the session has consumed — for the manager / caps display. */
  usage(): BrowserUsage {
    return { pages: this.pages, bytes: this.bytes, elapsedMs: this.now() - this.startedAt };
  }

  // ---- the seven tools ----------------------------------------------------------------------------

  navigate(url: string): Promise<BrowserStepResult> {
    return this.step({
      tool: "navigate",
      target: url,
      detail: `navigate ${url}`,
      perform: async () => {
        const res = await this.deps.page.goto(url);
        return { bytes: res.bytes, status: res.status, consumesPage: true };
      },
    });
  }

  readPage(): Promise<BrowserStepResult> {
    return this.step({
      tool: "read_page",
      target: this.currentUrl(),
      detail: "read page text + accessibility tree",
      perform: async () => {
        const page = await this.deps.page.snapshot();
        return { bytes: 0, page, consumesPage: false };
      },
    });
  }

  takeScreenshot(): Promise<BrowserStepResult> {
    return this.step({
      tool: "screenshot",
      target: this.currentUrl(),
      detail: "capture screenshot",
      perform: async () => ({ bytes: 0, consumesPage: false }),
    });
  }

  scroll(options?: { to?: "top" | "bottom"; deltaY?: number }): Promise<BrowserStepResult> {
    return this.step({
      tool: "scroll",
      target: this.currentUrl(),
      detail: `scroll ${options?.to ?? options?.deltaY ?? "default"}`,
      perform: async () => {
        await this.deps.page.scroll(options);
        return { bytes: 0, consumesPage: false };
      },
    });
  }

  wait(ms: number): Promise<BrowserStepResult> {
    return this.step({
      tool: "wait",
      target: this.currentUrl(),
      detail: `wait ${ms}ms`,
      perform: async () => ({ bytes: 0, consumesPage: false }),
    });
  }

  click(selector: string): Promise<BrowserStepResult> {
    return this.step({
      tool: "click",
      target: this.currentUrl(),
      detail: `click ${selector}`,
      perform: async () => {
        await this.deps.page.click(selector);
        return { bytes: 0, consumesPage: false };
      },
    });
  }

  /**
   * Type `text` into `selector`. Pass `credentialEntry` when the field is a password/credential input —
   * the step is then HARD-refused (`forbidden`), never gated-then-allowed: the agent browser never
   * enters credentials (ADR-0174 §2).
   */
  type(selector: string, text: string, opts?: { credentialEntry?: boolean }): Promise<BrowserStepResult> {
    return this.step({
      tool: "type",
      target: this.currentUrl(),
      credentialEntry: opts?.credentialEntry,
      detail: `type into ${selector}`,
      perform: async () => {
        await this.deps.page.type(selector, text);
        return { bytes: 0, consumesPage: false };
      },
    });
  }

  /** Tear down the page; the context is closed by the manager (which owns the isolation boundary). */
  async close(): Promise<void> {
    this.closed = true;
  }

  // ---- the single gated step path -----------------------------------------------------------------

  private currentUrl(): string {
    try {
      return this.deps.page.url();
    } catch {
      return "about:blank";
    }
  }

  private async step(req: StepRequest): Promise<BrowserStepResult> {
    if (this.closed) {
      return this.refuse(req, "deny", "session is closed", null);
    }
    const spec = browserToolSpec(req.tool);
    const usage = this.usage();

    // 1. The pure gate decides (caps + domain lists + side-effect), assuming no approval yet.
    const first = decideBrowserStep({
      tool: req.tool,
      target: req.target,
      caps: this.deps.caps,
      usage,
      credentialEntry: req.credentialEntry,
      captcha: req.captcha,
    });

    // 2. A side-effectful step that the gate says "needs_approval": ask the #13 gate.
    let approvalRequestId: string | null = null;
    let decision = first;
    if (first.decision === "needs_approval") {
      const verdict = await this.deps.approvalGate.ensure({
        workspaceId: this.deps.workspaceId,
        sessionId: this.deps.sessionId,
        tool: req.tool,
        target: req.target ?? null,
        summary: req.detail,
      });
      approvalRequestId = verdict.approvalRequestId;
      if (!verdict.approved) {
        // REFUSE — the driver is never touched. A #13 request is now pending for a human.
        return this.refuse(req, "needs_approval", verdict.reason, approvalRequestId);
      }
      // Approved: re-decide with `approved` so caps/domain are re-checked one more time.
      decision = decideBrowserStep({
        tool: req.tool,
        target: req.target,
        caps: this.deps.caps,
        usage,
        approved: true,
      });
    }

    if (decision.decision !== "allow") {
      return this.refuse(req, decision.decision, decision.reason, approvalRequestId);
    }

    // 3. Perform the action, update counters, capture a screenshot, and record a receipt. A driver
    //    failure (selector missing, nav timeout, page crash) must NOT crash the session: capture the
    //    failed state (best-effort) and record a failure receipt, then return ok:false.
    let performed: Awaited<ReturnType<StepRequest["perform"]>>;
    try {
      performed = await req.perform();
    } catch (err) {
      const failReason = err instanceof Error ? err.message : String(err);
      const { screenshotPath: failShot } = await this.capture(req.tool);
      const failUrl = req.target ?? this.currentUrl();
      this.stepNo += 1;
      await this.deps.receipts.record({
        sessionId: this.deps.sessionId,
        workspaceId: this.deps.workspaceId,
        stepNo: this.stepNo,
        tool: req.tool,
        url: failUrl,
        sideEffectful: spec.sideEffectful,
        decision: "deny",
        approvalRequestId,
        screenshotPath: failShot,
        bytes: 0,
        detail: `${req.detail} — failed: ${failReason}`,
      });
      return {
        ok: false,
        tool: req.tool,
        decision: "deny",
        reason: `browser action failed: ${failReason}`,
        url: failUrl,
        approvalRequestId,
        screenshotPath: failShot,
      };
    }
    if (performed.consumesPage) this.pages += 1;
    this.bytes += performed.bytes;

    const { screenshotPath, screenshot } = await this.capture(req.tool);
    const url = req.target ?? this.currentUrl();
    this.stepNo += 1;
    await this.deps.receipts.record({
      sessionId: this.deps.sessionId,
      workspaceId: this.deps.workspaceId,
      stepNo: this.stepNo,
      tool: req.tool,
      url,
      sideEffectful: spec.sideEffectful,
      decision: "allow",
      approvalRequestId,
      screenshotPath,
      bytes: performed.bytes,
      detail: req.detail,
    });

    return {
      ok: true,
      tool: req.tool,
      decision: "allow",
      reason: decision.reason,
      url,
      approvalRequestId,
      screenshotPath,
      page: performed.page,
      status: performed.status,
      screenshot,
    };
  }

  /** Capture a screenshot for the receipt stream. Best-effort: a screenshot failure never fails a step. */
  private async capture(tool: BrowserToolName): Promise<{ screenshotPath: string | null; screenshot?: string }> {
    try {
      const shot = await this.deps.page.screenshot();
      this.bytes += 0; // screenshot bytes are local capture, not network bandwidth — not counted.
      const path = await this.deps.screenshots.put({
        sessionId: this.deps.sessionId,
        stepNo: this.stepNo + 1,
        base64: shot.base64,
      });
      // The `screenshot` tool returns the image to the agent; other tools only attach it to the receipt.
      return { screenshotPath: path, screenshot: tool === "screenshot" ? shot.base64 : undefined };
    } catch {
      return { screenshotPath: null };
    }
  }

  /** Record a refusal receipt (no driver action happened) and return the refusal result. */
  private async refuse(
    req: StepRequest,
    decision: BrowserDecisionKind,
    reason: string,
    approvalRequestId: string | null,
  ): Promise<BrowserStepResult> {
    const spec = browserToolSpec(req.tool);
    const url = req.target ?? this.currentUrl();
    this.stepNo += 1;
    await this.deps.receipts.record({
      sessionId: this.deps.sessionId,
      workspaceId: this.deps.workspaceId,
      stepNo: this.stepNo,
      tool: req.tool,
      url,
      sideEffectful: spec.sideEffectful,
      decision,
      approvalRequestId,
      screenshotPath: null,
      bytes: 0,
      detail: `${req.detail} — refused: ${reason}`,
    });
    return { ok: false, tool: req.tool, decision, reason, url, approvalRequestId, screenshotPath: null };
  }
}
