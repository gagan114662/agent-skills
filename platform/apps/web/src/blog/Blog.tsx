/**
 * The public blog (#252) — a prerendered, indexable surface. Build-time prerendering (see
 * `entry-server.tsx` + `scripts/prerender.mjs`) renders these exact components to static HTML so a raw
 * fetch of `/blog` or `/blog/<slug>` returns real article text; the client then takes over for in-app
 * navigation. Reuses the marketing-site chrome (`SiteShell`), its index-card / document styles, and the
 * typed-block `Markdown` renderer — so there's no `dangerouslySetInnerHTML` and the look matches the
 * rest of the site with no new design.
 *
 * Routing is path-based (the no-router shell, #149): `/blog` is the index, `/blog/<slug>` is a post.
 */
import { useEffect } from "react";
import { BLOG, BRAND, FLEET, agentColor } from "../brand.js";
import { Link, useRoute } from "../routing.js";
import { SiteShell } from "../components/site/SiteShell.js";
import { Markdown } from "../components/site/Markdown.js";
import { currentLocale, dateLocale } from "../i18n.js";
import { getPost, listPostMeta, type BlogPostMeta, type BlogPost } from "./posts.js";

/** Parse a pathname into the blog slug (undefined → the index). */
export function blogSlug(path: string): string | undefined {
  const parts = path.replace(/^\/+/, "").split("/").filter(Boolean);
  // ["blog"] → index; ["blog", "<slug>"] → a post.
  return parts[0] === "blog" ? parts[1] : undefined;
}

/** Resolve an author handle (frontmatter `author`/`agent`) to a display credit + brand hue. */
function authorCredit(handle: string): { label: string; color: string } {
  const agent = FLEET.find((a) => a.handle === handle.toLowerCase());
  const name = agent?.name ?? (handle ? handle[0]!.toUpperCase() + handle.slice(1) : "the team");
  const dept = agent ? `, our ${agent.department.toUpperCase()} agent` : "";
  return { label: `${BLOG.byLabel} ${name}${dept}`, color: agentColor(name) ?? BRAND.accent };
}

/** A human-readable date ("June 14, 2026") from an ISO date string, or "" if unparseable. */
function formatDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(dateLocale(currentLocale()), { year: "numeric", month: "long", day: "numeric" });
}

function ByLine({ post, className }: { post: BlogPostMeta; className: string }): React.JSX.Element {
  const author = authorCredit(post.author);
  const date = formatDate(post.date);
  return (
    <p className={className}>
      <span style={{ color: author.color }}>{author.label}</span>
      {date && (
        <>
          {" · "}
          <time dateTime={post.date}>{date}</time>
        </>
      )}
      {post.readingTime && <>{` · ${post.readingTime}`}</>}
    </p>
  );
}

/** The `/blog` index: every published post, newest first. */
export function BlogIndex(): React.JSX.Element {
  const posts = listPostMeta();
  useEffect(() => {
    document.title = `${BLOG.title} — ${BRAND.name}`;
  }, []);
  return (
    <SiteShell>
      <header className="site-page__head">
        <p className="site-page__eyebrow">{BLOG.eyebrow}</p>
        <h1 className="site-page__title">{BLOG.title}</h1>
        <p className="site-page__sub">{BLOG.sub}</p>
      </header>
      {posts.length === 0 ? (
        <p className="site-page__note">{BLOG.empty}</p>
      ) : (
        <ul className="site-cards">
          {posts.map((post) => (
            <li key={post.slug} className="site-card">
              <Link href={`${BLOG.path}/${post.slug}`} className="site-card__link">
                <h2 className="site-card__title">{post.title}</h2>
                <p className="site-card__desc">{post.description}</p>
                <ByLine post={post} className="blog-by" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SiteShell>
  );
}

/** A single `/blog/<slug>` post (or a graceful not-found). */
export function BlogPostPage({ slug }: { slug: string }): React.JSX.Element {
  const post: BlogPost | undefined = getPost(slug);
  useEffect(() => {
    document.title = post ? `${post.title} — ${BRAND.name}` : `${BLOG.title} — ${BRAND.name}`;
  }, [post]);

  if (!post) {
    return (
      <SiteShell>
        <article>
          <Link href={BLOG.path} className="linklike site-doc__back">
            {BLOG.backToIndex}
          </Link>
          <p className="site-page__note">{BLOG.notFound}</p>
        </article>
      </SiteShell>
    );
  }

  return (
    <SiteShell>
      <article>
        <Link href={BLOG.path} className="linklike site-doc__back">
          {BLOG.backToIndex}
        </Link>
        <header className="site-doc__head">
          <h1 className="site-doc__title">{post.title}</h1>
          <ByLine post={post} className="blog-by" />
        </header>
        <Markdown blocks={post.blocks} />
      </article>
    </SiteShell>
  );
}

/** The blog router: `/blog` → index, `/blog/<slug>` → post. Default export so `AuthGate` can lazy-load it. */
export default function Blog(): React.JSX.Element {
  const path = useRoute();
  const slug = blogSlug(path);
  return slug ? <BlogPostPage slug={slug} /> : <BlogIndex />;
}
