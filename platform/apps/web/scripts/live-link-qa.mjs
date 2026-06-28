#!/usr/bin/env node
/**
 * Live link QA for ipop.ai (#1321). Crawls the production sitemap, extracts same-origin hrefs from
 * each prerendered page, and fails on any internal route that returns outside the 2xx/3xx range.
 * Dependency-free so it can run in GitHub Actions and from a local Vercel deploy session.
 */

const DEFAULT_TARGET = "https://ipop.ai/";
const DEFAULT_USER_AGENT = "ipop-live-link-qa/1.0";

export function normalizeTarget(raw = DEFAULT_TARGET) {
  const url = new URL(raw);
  url.hash = "";
  return url.toString();
}

export function normalizeLink(raw, base) {
  if (typeof raw !== "string") return null;
  const href = raw.trim();
  if (!href || href.startsWith("#")) return null;
  if (/^(mailto|tel|javascript|data):/i.test(href)) return null;
  try {
    const url = new URL(href, base);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function extractSitemapUrls(xml) {
  if (typeof xml !== "string") return [];
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1].trim()).filter(Boolean);
}

export function extractHrefUrls(html, base) {
  if (typeof html !== "string") return [];
  const urls = [];
  for (const match of html.matchAll(/\bhref=["']([^#"'][^"']*)["']/gi)) {
    const url = normalizeLink(match[1], base);
    if (url) urls.push(url);
  }
  return urls;
}

async function fetchText(fetcher, url) {
  const response = await fetcher(url, {
    redirect: "follow",
    headers: {
      "user-agent": DEFAULT_USER_AGENT,
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
  });
  const text = await response.text();
  return { response, text };
}

export async function runLiveLinkQa({
  target = process.env.PRODUCTION_WEB_URL || DEFAULT_TARGET,
  fetcher = fetch,
} = {}) {
  const root = normalizeTarget(target);
  const origin = new URL(root).origin;
  const pagesToCrawl = new Set([root]);
  const linksToCheck = new Set();
  const failures = [];

  try {
    const { response, text } = await fetchText(fetcher, new URL("/sitemap.xml", origin).toString());
    if (response.ok) {
      for (const url of extractSitemapUrls(text)) {
        if (new URL(url).origin === origin) pagesToCrawl.add(normalizeTarget(url));
      }
    } else {
      failures.push({ kind: "sitemap", url: new URL("/sitemap.xml", origin).toString(), status: response.status });
    }
  } catch (error) {
    failures.push({ kind: "sitemap_error", url: new URL("/sitemap.xml", origin).toString(), error: String(error) });
  }

  for (const pageUrl of pagesToCrawl) {
    try {
      const { response, text } = await fetchText(fetcher, pageUrl);
      if (!response.ok) {
        failures.push({ kind: "page", url: pageUrl, status: response.status });
        continue;
      }
      for (const link of extractHrefUrls(text, pageUrl)) {
        if (new URL(link).origin === origin) linksToCheck.add(link);
      }
    } catch (error) {
      failures.push({ kind: "page_error", url: pageUrl, error: String(error) });
    }
  }

  for (const linkUrl of linksToCheck) {
    try {
      const { response } = await fetchText(fetcher, linkUrl);
      if (!(response.status >= 200 && response.status < 400)) {
        failures.push({ kind: "link", url: linkUrl, status: response.status });
      }
    } catch (error) {
      failures.push({ kind: "link_error", url: linkUrl, error: String(error) });
    }
  }

  return {
    ok: failures.length === 0,
    target: root,
    pages: pagesToCrawl.size,
    links: linksToCheck.size,
    checked: pagesToCrawl.size + linksToCheck.size,
    failures,
  };
}

if (import.meta.url === "file://" + process.argv[1]) {
  runLiveLinkQa({ target: process.argv[2] })
    .then((result) => {
      if (result.ok) {
        console.log(
          "live link QA passed: " +
            result.target +
            " (" +
            result.pages +
            " sitemap pages, " +
            result.links +
            " same-origin links)",
        );
        return;
      }
      console.error("live link QA failed: " + result.target);
      for (const failure of result.failures) console.error("- " + JSON.stringify(failure));
      process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
