import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerAppExtensions } from "../../src/app-extensions/registry.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("registerAppExtensions", () => {
  it("loads extension modules in filename order without app.ts edits", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "app-ext-"));
    writeFileSync(
      join(tempDir, "02-beta.js"),
      'export default { name: "beta", register(app) { app.decorate("betaLoaded", true); } };',
    );
    writeFileSync(
      join(tempDir, "01-alpha.js"),
      'export default { name: "alpha", register(app) { app.get("/alpha", async () => ({ ok: true })); } };',
    );

    const app = Fastify();
    await registerAppExtensions(app, {}, { directory: tempDir });

    const response = await app.inject({ method: "GET", url: "/alpha" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect((app as unknown as { betaLoaded: boolean }).betaLoaded).toBe(true);
    await app.close();
  });

  it("ignores declaration files emitted beside JavaScript modules", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "app-ext-"));
    writeFileSync(
      join(tempDir, "01-alpha.js"),
      'export default { name: "alpha", register(app) { app.decorate("alphaLoaded", true); } };',
    );
    writeFileSync(join(tempDir, "01-alpha.d.ts"), "export interface AlphaExtension {}");

    const app = Fastify();
    await registerAppExtensions(app, {}, { directory: tempDir });

    expect((app as unknown as { alphaLoaded: boolean }).alphaLoaded).toBe(true);
    await app.close();
  });

});
