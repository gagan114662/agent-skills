import { describe, it, expect } from "vitest";
import { detectStack } from "../../src/deploy/detect.js";

/**
 * Pure stack detection (#73): infer { framework, buildCommand, outputDir } from package.json + the
 * app-root file listing, with a trusted-config override always winning. No filesystem in the core, so
 * it is exhaustively unit-testable and deterministic.
 */
describe("detectStack (#73 — pure framework inference)", () => {
  it("detects Next.js from the dependency", () => {
    const stack = detectStack(undefined, {
      packageJson: { dependencies: { next: "14.0.0", react: "18" } },
      files: ["package.json", "next.config.js"],
    });
    expect(stack).toEqual({ framework: "next", buildCommand: "next build", outputDir: ".next" });
  });

  it("detects Vite from a devDependency", () => {
    const stack = detectStack(undefined, {
      packageJson: { devDependencies: { vite: "5.0.0" } },
      files: ["package.json", "vite.config.ts", "index.html"],
    });
    expect(stack).toEqual({ framework: "vite", buildCommand: "vite build", outputDir: "dist" });
  });

  it("detects Create React App from react-scripts", () => {
    const stack = detectStack(undefined, {
      packageJson: { dependencies: { "react-scripts": "5.0.1" } },
      files: ["package.json"],
    });
    expect(stack).toEqual({ framework: "cra", buildCommand: "react-scripts build", outputDir: "build" });
  });

  it("detects Astro", () => {
    const stack = detectStack(undefined, {
      packageJson: { dependencies: { astro: "4.0.0" } },
      files: ["package.json", "astro.config.mjs"],
    });
    expect(stack).toEqual({ framework: "astro", buildCommand: "astro build", outputDir: "dist" });
  });

  it("falls back to a generic node build when a build script exists but no framework matches", () => {
    const stack = detectStack(undefined, {
      packageJson: { scripts: { build: "tsc -p ." }, dependencies: { express: "4" } },
      files: ["package.json"],
    });
    expect(stack).toEqual({ framework: "node", buildCommand: "npm run build", outputDir: "dist" });
  });

  it("treats a bare index.html with no package.json as a static site (no build)", () => {
    const stack = detectStack(undefined, {
      packageJson: null,
      files: ["index.html", "style.css"],
    });
    expect(stack).toEqual({ framework: "static", buildCommand: undefined, outputDir: "." });
  });

  it("defaults to static when nothing is recognizable", () => {
    const stack = detectStack(undefined, { packageJson: null, files: [] });
    expect(stack.framework).toBe("static");
  });

  it("lets a trusted-config framework override the inference", () => {
    const stack = detectStack(
      { framework: "vite" },
      { packageJson: { dependencies: { next: "14" } }, files: ["next.config.js"] },
    );
    // The override picks vite (with vite's defaults) even though next is present in the deps.
    expect(stack.framework).toBe("vite");
    expect(stack.buildCommand).toBe("vite build");
  });

  it("lets a trusted-config buildCommand/outputDir override the inferred framework's defaults", () => {
    const stack = detectStack(
      { buildCommand: "pnpm build", outputDir: "out" },
      { packageJson: { dependencies: { next: "14" } }, files: ["next.config.js"] },
    );
    expect(stack.framework).toBe("next"); // framework still inferred
    expect(stack.buildCommand).toBe("pnpm build"); // but the command is overridden
    expect(stack.outputDir).toBe("out");
  });
});
