/**
 * Blog component + routing tests (#252): the index lists posts, a post renders its markdown body, an
 * unknown slug degrades gracefully, and the path → slug parsing is correct.
 */
import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Blog, { BlogIndex, BlogPostPage, blogSlug } from "./Blog.js";
import { listPostMeta } from "./posts.js";
import { BLOG } from "../brand.js";

/** Point the (history-API) router at a path before rendering. */
function at(path: string): void {
  window.history.pushState({}, "", path);
}

afterEach(() => at("/"));

describe("blogSlug", () => {
  it("maps /blog to the index and /blog/<slug> to a post", () => {
    expect(blogSlug("/blog")).toBeUndefined();
    expect(blogSlug("/blog/")).toBeUndefined();
    expect(blogSlug("/blog/my-post")).toBe("my-post");
    expect(blogSlug("/blog/my-post/")).toBe("my-post");
  });
});

describe("BlogIndex", () => {
  it("renders the blog title and a link to every published post", () => {
    const { container } = render(<BlogIndex />);
    expect(screen.getByRole("heading", { level: 1, name: BLOG.title })).toBeInTheDocument();
    for (const post of listPostMeta()) {
      // The card is a block link wrapping the title (the site convention) — assert by href + title text.
      expect(screen.getByRole("heading", { level: 2, name: post.title })).toBeInTheDocument();
      expect(container.querySelector(`a[href="${BLOG.path}/${post.slug}"]`)).toBeTruthy();
    }
  });
});

describe("BlogPostPage", () => {
  it("renders the post headline and body text for a known slug", () => {
    const post = listPostMeta()[0]!;
    render(<BlogPostPage slug={post.slug} />);
    expect(screen.getByRole("heading", { level: 1, name: post.title })).toBeInTheDocument();
    // A back-link to the index is always present.
    expect(screen.getByRole("link", { name: BLOG.backToIndex })).toHaveAttribute("href", BLOG.path);
  });

  it("shows a graceful not-found for an unknown slug (no crash)", () => {
    render(<BlogPostPage slug="does-not-exist" />);
    expect(screen.getByText(BLOG.notFound)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: BLOG.backToIndex })).toBeInTheDocument();
  });
});

describe("Blog router", () => {
  it("renders the index at /blog", () => {
    at("/blog");
    render(<Blog />);
    expect(screen.getByRole("heading", { level: 1, name: BLOG.title })).toBeInTheDocument();
  });

  it("renders a post at /blog/<slug>", () => {
    const post = listPostMeta()[0]!;
    at(`/blog/${post.slug}`);
    render(<Blog />);
    expect(screen.getByRole("heading", { level: 1, name: post.title })).toBeInTheDocument();
  });
});
