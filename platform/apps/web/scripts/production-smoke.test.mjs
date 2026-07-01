import test from "node:test";
import assert from "node:assert/strict";
import { ROUTE_CONTRACTS, VIEWPORTS, findDevHrefs, normalizeBaseUrl, routeUrl } from "./production-smoke.mjs";

test("normalizeBaseUrl keeps a trailing slash for route joining", () => {
  assert.equal(normalizeBaseUrl("https://ipop.ai"), "https://ipop.ai/");
  assert.equal(routeUrl("https://ipop.ai", "/dashboard"), "https://ipop.ai/dashboard");
});

test("findDevHrefs catches localhost and file links without flagging production links", () => {
  assert.deepEqual(findDevHrefs(["/pricing", "https://ipop.ai/start", "mailto:support@ipop.ai"]), []);
  assert.deepEqual(findDevHrefs(["http://localhost:5173", "https://127.0.0.1:3000/x", "file:///tmp/index.html"]), [
    "http://localhost:5173",
    "https://127.0.0.1:3000/x",
    "file:///tmp/index.html",
  ]);
});

test("production smoke covers the public routes that sell and prove ipop", () => {
  const paths = ROUTE_CONTRACTS.map((contract) => contract.path);
  for (const required of ["/", "/start", "/dashboard", "/pricing", "/login", "/signup", "/terms", "/privacy", "/does-not-exist"]) {
    assert.ok(paths.includes(required), required);
  }
  assert.ok(ROUTE_CONTRACTS.find((contract) => contract.path === "/dashboard")?.texts.includes("work that matters"));
  assert.ok(ROUTE_CONTRACTS.find((contract) => contract.path === "/does-not-exist")?.texts.includes("Page not found"));
  assert.ok(ROUTE_CONTRACTS.find((contract) => contract.path === "/pricing")?.texts.includes("$499"));
});

test("production smoke runs desktop and mobile contracts", () => {
  assert.deepEqual(VIEWPORTS.map((viewport) => viewport.name), ["desktop", "mobile"]);
});
