/**
 * The build-time SSR entry (#252). It renders the public marketing surfaces to static HTML so a raw
 * fetch (what a search crawler does first) returns the real headline, sections, and article text —
 * instead of the empty `<div id="root">` a client-rendered SPA ships. `scripts/prerender.mjs` imports
 * this after the normal Vite build, injects each page's body into the built `index.html` shell, and
 * writes the static files (`/index.html`, `/blog/index.html`, `/blog/<slug>/index.html`, `sitemap.xml`,
 * `robots.txt`). The browser then hydrates the full interactive app over the prerendered markup via the
 * existing `main.tsx` (createRoot) — visitors get the identical experience; crawlers get real content.
 *
 * Only `renderToStaticMarkup` is used (no hydration markers): the client mounts with `createRoot`, which
 * cleanly replaces the static markup, so there's no hydration-mismatch risk from the app's async session
 * bootstrap. Components reached here are SSR-safe — every `window`/`document` access lives in effects,
 * which `renderToStaticMarkup` never runs.
 */
import { renderToStaticMarkup } from "react-dom/server";
import {
  BLOG,
  BRAND,
  COMPARE,
  STORIES,
  GUIDES,
  CHANGELOG,
  PAGE_SEO,
  PRICING,
  SEGMENT_LANDING_PAGES,
} from "./brand.js";
import { PricingPage } from "./components/landing/PricingPage.js";
import { RefundPolicy } from "./components/landing/RefundPolicy.js";
import { Security } from "./components/landing/Security.js";
import { DemoSandbox } from "./components/demo/DemoSandbox.js";
import { OnboardingExperience } from "./components/onboarding/OnboardingExperience.js";
import { PublicDoorFooter, PublicDoorNav } from "./components/onboarding/PublicDoorNav.js";
import { EverydayShell } from "./components/everyday/EverydayShell.js";
import { ipopDogfoodEveryday } from "./components/everyday/everyday-data.js";
import { experienceTokenStyle } from "./design/ipop-experience-tokens.js";
import { LegalPage } from "./components/landing/LegalPage.js";
import { CompanyPage } from "./components/landing/CompanyPage.js";
import { SiteShell } from "./components/site/SiteShell.js";
import { SectionPage } from "./components/site/SectionPage.js";
import { Brand } from "./components/site/Brand.js";
import { SegmentLandingPage } from "./components/site/SegmentLandingPage.js";
import { BlogIndex, BlogPostPage } from "./blog/Blog.js";
import { listPostMeta, type BlogPostMeta } from "./blog/posts.js";
import { hreflangLinks } from "./i18n.js";
import { resolveOrigin, escapeHtml, type PrerenderPage } from "./blog/seo.js";
import {
  organizationLd,
  softwareApplicationLd,
  websiteLd,
  blogLd,
  blogPostingLd,
  breadcrumbLd,
  renderJsonLd,
} from "./blog/structured-data.js";

// Re-export the pure SEO helpers so the prerender build script (scripts/prerender.mjs) can import
// everything it needs from this one built SSR bundle.
export { resolveOrigin, resolveBuildSha, injectBuildStamp, injectPage, buildSitemap, buildRobots } from "./blog/seo.js";
export type { PrerenderPage } from "./blog/seo.js";

// The prerender origin (same resolution the build script uses) so JSON-LD URLs are absolute + canonical.
const ORIGIN = resolveOrigin(typeof process !== "undefined" ? process.env : {});

/** Per-post `<meta property="article:*">` tags (Open Graph article extensions) for a post page. */
function articleMeta(post: BlogPostMeta): string {
  const tags: string[] = [];
  if (post.date) tags.push(`<meta property="article:published_time" content="${escapeHtml(post.date)}" />`);
  tags.push(`<meta property="article:author" content="${escapeHtml(post.author)}" />`);
  return tags.map((t) => `  ${t}`).join("\n");
}

/**
 * The public marketing surfaces beyond the homepage and the blog (#467): the focused pricing page and the
 * five content-site sections (compare / stories / guides / changelog / brand). Before this, every one of
 * these fell through `AuthGate` to the SPA shell — a crawler got an empty `<div id="root">` and the
 * homepage's shared `<title>` / description / H1 (Scout's "all routes share the same title" finding).
 *
 * Each is now rendered to static HTML with its own front-loaded title + description (from `PAGE_SEO`) and a
 * Home › Page breadcrumb. The section indexes' card lists still hydrate from the live content API on the
 * client, but everything a crawler indexes — the headline, the intro copy, the nav, and the footer — is
 * server-rendered here. The body wrappers mirror what the client mounts (`SiteShell` chrome for the content
 * sections; `PricingPage` carries its own nav/footer) so the prerendered markup matches the hydrated page.
 */
function marketingPages(): PrerenderPage[] {
  const body: Record<keyof typeof PAGE_SEO, React.JSX.Element> = {
    "/start": <OnboardingExperience hour={14} />,
    "/welcome": <OnboardingExperience hour={14} />,
    "/demo": <DemoSandbox />,
    "/sandbox": <DemoSandbox />,
    "/login": <StaticAuthPage mode="login" />,
    "/signup": <StaticAuthPage mode="signup" />,
    "/everyday": <StaticAppRouteShell eyebrow="Signed-in workspace" title="Everyday workspace" body="Review approvals, receipts, and the work queue after signing in. This route never serves the homepage to crawlers." />,
    "/dashboard": <StaticPublicDashboard />,
    "/theater": <StaticAppRouteShell eyebrow="Signed-in workspace" title="Agent theater" body="Watch workspace-scoped reasoning, actions, artifacts, and receipts after signing in." />,
    "/support/status": <StaticAppRouteShell eyebrow="Support ticket" title="Ticket status" body="Open a ticket status link with its secure parameters to see SLA, response state, and timeline." />,
    "/status/test": <StaticAppRouteShell eyebrow="Public status" title="Workspace status" body="Published status pages show component health and incident history for workspaces that opt in." />,
    "/pricing": <PricingPage />,
    "/refund-policy": <RefundPolicy />,
    "/security": <Security />,
    "/terms": <LegalPage kind="terms" />,
    "/privacy": <LegalPage kind="privacy" />,
    "/company": <CompanyPage />,
    "/dpa": <LegalPage kind="dpa" />,
    "/compare": (
      <SiteShell>
        <SectionPage section="compare" copy={COMPARE} />
      </SiteShell>
    ),
    "/stories": (
      <SiteShell>
        <SectionPage section="stories" copy={STORIES} />
      </SiteShell>
    ),
    "/guides": (
      <SiteShell>
        <SectionPage section="guides" copy={GUIDES} />
      </SiteShell>
    ),
    "/changelog": (
      <SiteShell>
        <SectionPage section="changelog" copy={CHANGELOG} />
      </SiteShell>
    ),
    "/brand": (
      <SiteShell>
        <Brand />
      </SiteShell>
    ),
  };
  // Pricing is a primary conversion + SEO destination, so it outranks the content-section indexes.
  const priority: Partial<Record<keyof typeof PAGE_SEO, number>> = { "/demo": 0.9, "/pricing": 0.9, "/welcome": 0.9 };

  return (Object.keys(PAGE_SEO) as (keyof typeof PAGE_SEO)[]).map((urlPath) => {
    const seo = PAGE_SEO[urlPath];
    return {
      outFile: `${urlPath.replace(/^\//, "")}/index.html`,
      urlPath,
      html: renderToStaticMarkup(body[urlPath]),
      title: seo.title,
      description: seo.description,
    priority: priority[urlPath] ?? 0.6,
      headExtra:
        hreflangLinks(ORIGIN, urlPath) +
        "\n" +
        renderJsonLd(
        breadcrumbLd(ORIGIN, [
          [BRAND.name, "/"],
          [seo.name, urlPath],
        ]),
      ),
    };
  });
}

function StaticPublicDashboard(): React.JSX.Element {
  return (
    <div className="public-dashboard" style={experienceTokenStyle("onboarding")}>
      <PublicDoorNav className="public-dashboard__nav" startHref="/start#onboard-target" />
      <h1 className="sr-only">CMO brief</h1>
      <EverydayShell data={ipopDogfoodEveryday()} dashboardFirst dashboardOnly />
      <PublicDoorFooter className="public-dashboard__footer" />
    </div>
  );
}

function StaticAppRouteShell(props: { eyebrow: string; title: string; body: string }): React.JSX.Element {
  return (
    <main className="splash">
      <p className="auth__trial-badge">{props.eyebrow}</p>
      <h1>{props.title}</h1>
      <p>{props.body}</p>
      <a className="btn btn--primary" href="/login">
        Log in
      </a>
    </main>
  );
}

function StaticAuthPage({ mode }: { mode: "login" | "signup" }): React.JSX.Element {
  const isSignup = mode === "signup";
  return (
    <div className="auth auth--message" style={experienceTokenStyle("onboarding")}>
      <div className="auth-message__sunscape" aria-hidden="true">
        <span className="auth-message__ray auth-message__ray--one" />
        <span className="auth-message__ray auth-message__ray--two" />
        <span className="auth-message__ray auth-message__ray--three" />
        <span className="auth-message__sun" />
      </div>
      <header className="auth-message__nav">
        <a href="/" className="auth-message__brand" aria-label={BRAND.name}>
          <span className="auth-message__brand-word">{BRAND.name}</span>
          <span className="auth-message__proof">marketing team in your messages</span>
        </a>
      </header>
      <main className="auth-message__layout">
        <section className="auth-message__copy" aria-label="messaging setup">
          <p className="auth-message__eyebrow">messaging setup</p>
          <h1>{isSignup ? "Create your agent room" : "Sign in to your agent room"}</h1>
          <p>Continue iMessage, WhatsApp, and Telegram room setup after this.</p>
        </section>
      <form className="auth__card auth__card--message">
        <h2 className="auth__headline">{isSignup ? "Start here" : "Welcome back"}</h2>
        <p className="auth__tag">Back to your marketing team in messages.</p>
        {isSignup && (
          <p className="auth__trial" role="note">
            <span className="auth__trial-badge">{PRICING.trial.eyebrow}</span> {PRICING.trial.generic}
          </p>
        )}
        {isSignup && (
          <label className="field">
            Display name
            <input name="name" autoComplete="name" />
          </label>
        )}
        <label className="field">
          Email
          <input type="email" name="email" autoComplete="email" />
        </label>
        <label className="field">
          Password
          <input type="password" name="password" autoComplete={isSignup ? "new-password" : "current-password"} />
        </label>
        {isSignup && (
          <label className="field">
            Workspace
            <input name="workspace" />
          </label>
        )}
        <button className="btn btn--primary" type="submit">
          {isSignup ? "Create account" : "Sign in"}
        </button>
      </form>
      </main>
    </div>
  );
}

function segmentPages(): PrerenderPage[] {
  return SEGMENT_LANDING_PAGES.map((segment) => ({
    outFile: segment.path.replace(/^\//, "") + "/index.html",
    urlPath: segment.path,
    html: renderToStaticMarkup(
      <SiteShell>
        <SegmentLandingPage page={segment} />
      </SiteShell>,
    ),
    title: segment.seoTitleSubject + " — " + BRAND.name,
    description: segment.seoDescription,
    priority: 0.7,
    headExtra:
      hreflangLinks(ORIGIN, segment.path) +
      "\n" +
      renderJsonLd(
        breadcrumbLd(ORIGIN, [
          [BRAND.name, "/"],
          [segment.navLabel, segment.path],
        ]),
      ),
  }));
}

/** Build the full set of pages to prerender (home + pricing + marketing sections + blog index + posts). */
export function prerenderPages(): PrerenderPage[] {
  const pages: PrerenderPage[] = [];

  const posts = listPostMeta();

  // The marketing homepage. It must prerender the same message-first public door the client shows at `/`;
  // otherwise production can serve the stale brochure homepage until JS hydrates. Its head meta already lives
  // in index.html, so we only inject the body — plus the Organization + WebSite JSON-LD (#294) and the
  // SoftwareApplication node (#467) so crawlers understand ipop as the SaaS product it is.
  pages.push({
    outFile: "index.html",
    urlPath: "/",
    html: renderToStaticMarkup(<OnboardingExperience hour={14} />),
    lastmod: posts[0]?.date,
    priority: 1.0,
    headExtra:
      hreflangLinks(ORIGIN, "/") +
      "\n" +
      renderJsonLd([organizationLd(ORIGIN), websiteLd(ORIGIN), softwareApplicationLd(ORIGIN)]),
  });

  // The pricing page + the five content-site sections (#467) — each with its own front-loaded head meta.
  pages.push(...marketingPages());
  pages.push(...segmentPages());

  // The blog index: Blog node (lists every post) + a Home › Blog breadcrumb.
  pages.push({
    outFile: "blog/index.html",
    urlPath: "/blog",
    html: renderToStaticMarkup(<BlogIndex />),
    title: `${BLOG.title} — ${BRAND.name}`,
    description: BLOG.sub,
    lastmod: posts[0]?.date,
    priority: 0.8,
    headExtra:
      hreflangLinks(ORIGIN, "/blog") +
      "\n" +
      renderJsonLd([
      blogLd(ORIGIN, posts),
      breadcrumbLd(ORIGIN, [
        [BRAND.name, "/"],
        [BLOG.title, "/blog"],
      ]),
    ]),
  });

  // Each published post: BlogPosting + a Home › Blog › Post breadcrumb, og:type=article, and article meta.
  for (const post of posts) {
    pages.push({
      outFile: `blog/${post.slug}/index.html`,
      urlPath: `/blog/${post.slug}`,
      html: renderToStaticMarkup(<BlogPostPage slug={post.slug} />),
      title: `${post.title} — ${BRAND.name}`,
      description: post.description,
      lastmod: post.date,
      priority: 0.7,
      ogType: "article",
      headExtra:
        hreflangLinks(ORIGIN, `/blog/${post.slug}`) +
        "\n" +
        renderJsonLd([
          blogPostingLd(ORIGIN, post),
          breadcrumbLd(ORIGIN, [
            [BRAND.name, "/"],
            [BLOG.title, "/blog"],
            [post.title, `/blog/${post.slug}`],
          ]),
        ]) +
        "\n" +
        articleMeta(post),
    });
  }

  return pages;
}
