#!/usr/bin/env node
/**
 * Browser-level production smoke for the public ipop experience (#1495). It checks the routes that sell
 * and explain the product in real Chromium across desktop and mobile. Failures save screenshots so the
 * next agent sees what actually broke instead of reading a vague 404/grep failure.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TARGET = "https://ipop.ai/";
const DEFAULT_ARTIFACT_DIR = "production-smoke-artifacts";

export const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844, isMobile: true },
];

export const ROUTE_CONTRACTS = [
  {
    path: "/",
    status: 200,
    texts: ["Make marketing pop.", "Login", "Love", "Dashboard", "Start"],
  },
  {
    path: "/start",
    status: 200,
    texts: ["Start", "Make marketing pop."],
  },
  {
    path: "/dashboard",
    status: 200,
    texts: ["CMO brief", "pipeline moved", "since last check-in", "agent work by business impact", "blocked channels"],
  },
  {
    path: "/pricing",
    status: 200,
    texts: ["Starter", "Pro", "Agency", "$49", "$199", "$499", "Start"],
  },
  {
    path: "/login",
    status: 200,
    texts: ["Welcome back", "Sign in"],
  },
  {
    path: "/signup",
    status: 200,
    texts: ["Start here", "Create account"],
  },
  {
    path: "/terms",
    status: 200,
    texts: ["Terms"],
  },
  {
    path: "/privacy",
    status: 200,
    texts: ["Privacy"],
  },
  {
    path: "/does-not-exist",
    status: 404,
    texts: [],
  },
];

export function normalizeBaseUrl(raw = DEFAULT_TARGET) {
  const url = new URL(raw);
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

export function routeUrl(base, path) {
  return new URL(path.replace(/^\//, ""), normalizeBaseUrl(base)).toString();
}

export function findDevHrefs(hrefs) {
  return hrefs.filter((href) => /(?:^|\/\/)(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::|\/|$)|^file:/i.test(href));
}

async function assertText(page, text) {
  await page.getByText(text, { exact: false }).first().waitFor({ state: "visible", timeout: 7000 });
}

async function collectHrefCandidates(page) {
  return page.$$eval("a[href]", (anchors) =>
    anchors.map((anchor) => anchor.getAttribute("href")).filter(Boolean),
  );
}

async function smokeOnePage({ page, baseUrl, contract, viewport, artifactDir }) {
  const url = routeUrl(baseUrl, contract.path);
  const response = await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });
  const status = response?.status() ?? 0;
  const failures = [];

  if (status !== contract.status) failures.push(`${contract.path} returned ${status}, expected ${contract.status}`);

  if (status >= 200 && status < 400) {
    const bodyText = (await page.locator("body").innerText({ timeout: 5000 })).trim();
    if (bodyText.length < 20) failures.push(`${contract.path} rendered a nearly blank body`);

    for (const text of contract.texts) {
      try {
        await assertText(page, text);
      } catch {
        failures.push(`${contract.path} is missing visible text: ${JSON.stringify(text)}`);
      }
    }

    const badHrefs = findDevHrefs(await collectHrefCandidates(page));
    if (badHrefs.length > 0) failures.push(`${contract.path} exposes dev-only hrefs: ${badHrefs.join(", ")}`);
  }

  if (failures.length > 0) {
    await mkdir(artifactDir, { recursive: true });
    const safePath = contract.path === "/" ? "home" : contract.path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
    await page.screenshot({ path: join(artifactDir, `${viewport.name}-${safePath}.png`), fullPage: true });
  }

  return { route: contract.path, viewport: viewport.name, status, failures };
}

export async function runProductionSmoke({
  baseUrl = process.env.PRODUCTION_WEB_URL || DEFAULT_TARGET,
  artifactDir = process.env.PRODUCTION_SMOKE_ARTIFACT_DIR || DEFAULT_ARTIFACT_DIR,
  contracts = ROUTE_CONTRACTS,
  viewports = VIEWPORTS,
} = {}) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const results = [];

  try {
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        isMobile: viewport.isMobile ?? false,
      });
      const page = await context.newPage();
      for (const contract of contracts) {
        results.push(await smokeOnePage({ page, baseUrl, contract, viewport, artifactDir }));
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }

  const failures = results.flatMap((result) => result.failures.map((failure) => ({ ...result, failure })));
  return { ok: failures.length === 0, baseUrl: normalizeBaseUrl(baseUrl), checked: results.length, failures, results };
}

function isCliEntrypoint() {
  return Boolean(process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]));
}

if (isCliEntrypoint()) {
  runProductionSmoke({ baseUrl: process.argv[2] || undefined })
    .then((result) => {
      if (result.ok) {
        console.log(`production smoke passed: ${result.checked} route/viewport checks for ${result.baseUrl}`);
        return;
      }
      console.error(`production smoke failed: ${result.baseUrl}`);
      for (const failure of result.failures) console.error(`- [${failure.viewport} ${failure.route}] ${failure.failure}`);
      console.error(`screenshots: ${process.env.PRODUCTION_SMOKE_ARTIFACT_DIR || DEFAULT_ARTIFACT_DIR}`);
      process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
