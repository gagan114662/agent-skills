import { describe, it, expect } from "vitest";
import type { PreviewAnnotation } from "@reload/shared";
import { detectUrl, formatAnnotationsTask } from "../../src/run/detect.js";

describe("detectUrl (#56 port/url detection)", () => {
  it("detects a Vite-style 'Local: http://localhost:PORT' line", () => {
    expect(detectUrl("  ➜  Local:   http://localhost:5173/")).toBe("http://localhost:5173");
  });

  it("detects a bare scheme url", () => {
    expect(detectUrl("Server running at http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("normalizes 127.0.0.1 to localhost so the browser can reach it", () => {
    expect(detectUrl("listening on http://127.0.0.1:4000")).toBe("http://localhost:4000");
  });

  it("detects a 'listening on port N' line with no url", () => {
    expect(detectUrl("Express server listening on port 8080")).toBe("http://localhost:8080");
  });

  it("detects a bare host:port", () => {
    expect(detectUrl("now serving localhost:9090")).toBe("http://localhost:9090");
  });

  it("rejects an out-of-range port", () => {
    expect(detectUrl("listening on http://localhost:99999")).toBeNull();
  });

  it("returns null for noise and empty lines", () => {
    expect(detectUrl("compiling modules... 42% done")).toBeNull();
    expect(detectUrl("")).toBeNull();
    expect(detectUrl("port of call: the harbor")).toBeNull();
  });

  it("honors a custom readyPattern capturing the port in group 1", () => {
    expect(detectUrl("APP_UP on slot 7654 ready", "APP_UP on slot (\\d+)")).toBe(
      "http://localhost:7654",
    );
  });

  it("honors a custom readyPattern capturing a full url in group 1", () => {
    expect(detectUrl("READY url=http://localhost:6001/app", "url=(\\S+)")).toBe(
      "http://localhost:6001/app",
    );
  });

  it("ignores an invalid custom pattern rather than throwing", () => {
    expect(detectUrl("http://localhost:5173", "([")).toBe("http://localhost:5173");
  });

  it("is ReDoS-safe on a pathological line", () => {
    const line = `port ${"a".repeat(100_000)}`;
    const start = Date.now();
    expect(detectUrl(line)).toBeNull();
    expect(Date.now() - start).toBeLessThan(100);
  });
});

describe("formatAnnotationsTask (#56 annotation round trip)", () => {
  it("renders normalized coords, optional size, and the note into a task string", () => {
    const anns: PreviewAnnotation[] = [
      { x: 0.34, y: 0.12, note: "the Save button is misaligned", pageUrl: "http://localhost:5173" },
      {
        x: 0.5,
        y: 0.8,
        width: 0.2,
        height: 0.1,
        note: "footer overlaps content",
        pageUrl: "http://localhost:5173",
      },
    ];
    const task = formatAnnotationsTask(anns);
    expect(task).toContain("http://localhost:5173");
    expect(task).toContain("(34%, 12%)");
    expect(task).toContain("the Save button is misaligned");
    expect(task).toContain("(50%, 80%)");
    expect(task).toContain("[20%×10%]");
    expect(task).toContain("footer overlaps content");
  });

  it("falls back to a generic location when no pageUrl is present", () => {
    const task = formatAnnotationsTask([
      { x: 0.1, y: 0.1, note: "fix this", pageUrl: "" },
    ]);
    expect(task).toContain("the running preview");
    expect(task).toContain("fix this");
  });
});
