import { describe, it, expect } from "vitest";
import { resolveBrowserCaps } from "../../src/runtime/browser/caps.js";
import {
  createFakeBrowserDriver,
  type FakeBrowserPage,
} from "../../src/runtime/browser/driver.js";
import type { BrowserToolName } from "../../src/runtime/browser/tools.js";
import {
  autoApprovalGate,
  pendingApprovalGate,
} from "../../src/runtime/browser/approval.js";
import { inMemoryReceiptRecorder } from "../../src/runtime/browser/receipts.js";
import { inMemoryScreenshotStore } from "../../src/runtime/browser/screenshots.js";
import { BrowserSession } from "../../src/runtime/browser/session.js";

async function makeSession(opts: {
  caps?: Parameters<typeof resolveBrowserCaps>[0];
  approvalGate?: ReturnType<typeof pendingApprovalGate>;
  now?: () => number;
  failTools?: BrowserToolName[];
}) {
  const driver = createFakeBrowserDriver({ failTools: opts.failTools });
  const context = await driver.newContext({ sessionId: "s1", workspaceId: "w1" });
  const page = (await context.newPage()) as FakeBrowserPage;
  const receipts = inMemoryReceiptRecorder();
  const approvalGate = opts.approvalGate ?? pendingApprovalGate();
  const session = new BrowserSession({
    sessionId: "s1",
    workspaceId: "w1",
    caps: resolveBrowserCaps(opts.caps ?? { enabled: true }),
    context,
    page,
    approvalGate,
    receipts,
    screenshots: inMemoryScreenshotStore(),
    now: opts.now,
  });
  return { session, page, receipts, approvalGate };
}

describe("BrowserSession (#174)", () => {
  describe("read-only browsing is free", () => {
    it("navigate + read_page run without any approval and produce receipts with screenshots", async () => {
      const { session, page, receipts } = await makeSession({});
      const nav = await session.navigate("https://example.com");
      expect(nav.ok).toBe(true);
      expect(nav.status).toBe(200);
      expect(page.calls).toContain("goto:https://example.com");

      const read = await session.readPage();
      expect(read.ok).toBe(true);
      expect(read.page?.text).toContain("example.com");

      // Every step recorded a receipt; allowed steps carry a screenshot path.
      expect(receipts.receipts).toHaveLength(2);
      expect(receipts.receipts[0]?.tool).toBe("navigate");
      expect(receipts.receipts[0]?.screenshotPath).toMatch(/screenshots\/s1\/step-/);
      expect(receipts.receipts.every((r) => r.decision === "allow")).toBe(true);
    });
  });

  describe("approval-gate enforcement (the safety contract)", () => {
    it("a click (side-effectful) WITHOUT approval refuses and never touches the driver", async () => {
      const gate = pendingApprovalGate();
      const { session, page, receipts } = await makeSession({ approvalGate: gate });
      const res = await session.click("#buy-now");
      expect(res.ok).toBe(false);
      expect(res.decision).toBe("needs_approval");
      expect(res.approvalRequestId).toBe("pending-1");
      // The driver was NEVER asked to click.
      expect(page.calls.some((c) => c.startsWith("click:"))).toBe(false);
      // A #13 request was raised, and the refusal is on the audit trail.
      expect(gate.requests).toHaveLength(1);
      expect(gate.requests[0]?.tool).toBe("click");
      expect(receipts.receipts[0]?.decision).toBe("needs_approval");
    });

    it("a typed form submit WITHOUT approval refuses", async () => {
      const { session, page } = await makeSession({});
      const res = await session.type("#comment", "hello world");
      expect(res.ok).toBe(false);
      expect(res.decision).toBe("needs_approval");
      expect(page.calls.some((c) => c.startsWith("type:"))).toBe(false);
    });

    it("once approved, the side-effectful action runs and is recorded with the approval id", async () => {
      const { session, page, receipts } = await makeSession({ approvalGate: autoApprovalGate() });
      const res = await session.click("#buy-now");
      expect(res.ok).toBe(true);
      expect(res.decision).toBe("allow");
      expect(res.approvalRequestId).toBe("approved-1");
      expect(page.calls).toContain("click:#buy-now");
      expect(receipts.receipts[0]?.approvalRequestId).toBe("approved-1");
    });

    it("NEVER enters credentials — even with an auto-approve gate (hard forbidden)", async () => {
      const { session, page } = await makeSession({ approvalGate: autoApprovalGate() });
      const res = await session.type("#password", "hunter2", { credentialEntry: true });
      expect(res.ok).toBe(false);
      expect(res.decision).toBe("forbidden");
      expect(page.calls.some((c) => c.startsWith("type:"))).toBe(false);
    });
  });

  describe("driver failure does not crash the session", () => {
    it("a failed navigation records a failure receipt + returns ok:false (no throw)", async () => {
      const { session, receipts } = await makeSession({ failTools: ["navigate"] });
      const res = await session.navigate("https://example.com");
      expect(res.ok).toBe(false);
      expect(res.decision).toBe("deny");
      expect(res.reason).toMatch(/browser action failed/);
      // The receipt captured the failure (and a best-effort screenshot of the failed state).
      expect(receipts.receipts).toHaveLength(1);
      expect(receipts.receipts[0]?.detail).toMatch(/failed:/);
      // The session is still usable afterward — a subsequent read works.
      const read = await session.readPage();
      expect(read.ok).toBe(true);
    });

    it("a failed approved click records a failure receipt + returns ok:false", async () => {
      const { session, receipts } = await makeSession({ approvalGate: autoApprovalGate(), failTools: ["click"] });
      const res = await session.click("#buy-now");
      expect(res.ok).toBe(false);
      expect(res.decision).toBe("deny");
      expect(receipts.receipts[0]?.detail).toMatch(/failed:/);
    });
  });

  describe("caps enforcement", () => {
    it("stops navigations once the page cap is hit (but allows non-page reads)", async () => {
      const { session } = await makeSession({ caps: { enabled: true, maxPages: 2 } });
      expect((await session.navigate("https://a.com")).ok).toBe(true);
      expect((await session.navigate("https://b.com")).ok).toBe(true);
      const third = await session.navigate("https://c.com");
      expect(third.ok).toBe(false);
      expect(third.decision).toBe("deny");
      expect(third.reason).toMatch(/page cap/);
      // A read still works — only the page cap is exhausted.
      expect((await session.readPage()).ok).toBe(true);
    });

    it("stops every tool once the wall-clock cap elapses", async () => {
      let t = 1_000;
      const { session } = await makeSession({ caps: { enabled: true, maxWallClockSeconds: 5 }, now: () => t });
      expect((await session.navigate("https://a.com")).ok).toBe(true);
      t += 6_000; // 6s > 5s cap
      const res = await session.readPage();
      expect(res.ok).toBe(false);
      expect(res.reason).toMatch(/wall-clock/);
    });

    it("stops once the bandwidth cap is reached (fake nav = 100 bytes each)", async () => {
      const { session } = await makeSession({ caps: { enabled: true, maxBandwidthBytes: 100 } });
      expect((await session.navigate("https://a.com")).ok).toBe(true); // consumes 100 → at the cap
      const second = await session.navigate("https://b.com"); // 100 >= 100 → denied
      expect(second.ok).toBe(false);
      expect(second.reason).toMatch(/bandwidth/);
    });
  });
});
