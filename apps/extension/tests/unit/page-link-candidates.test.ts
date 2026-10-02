import { beforeEach, describe, expect, it } from "vitest";

import {
  linkCandidateFor,
  pickedLinkUrl,
} from "../../src/page-link-candidates.js";

describe("picked link addresses", () => {
  it.each([
    [
      "https://x.com/alice/status/123?s=20#top",
      "https://x.com/alice/status/123",
    ],
    [
      "https://twitter.com/alice/status/123/video/1",
      "https://x.com/alice/status/123",
    ],
    [
      "https://mobile.twitter.com/alice/status/123",
      "https://x.com/alice/status/123",
    ],
    ["https://mobile.x.com/alice/status/123", "https://x.com/alice/status/123"],
    ["https://x.com./alice/status/123", "https://x.com/alice/status/123"],
    ["https://x.com../alice/status/1", "https://x.com/alice/status/1"],
    // Look-alike hosts stop at the dot boundary: ordinary links, unchanged.
    ["https://evilx.com/alice/status/1", "https://evilx.com/alice/status/1"],
    ["https://x.com.evil.example/home", "https://x.com.evil.example/home"],
    [
      "https://youtube.com.evil.example/watch?v=x",
      "https://youtube.com.evil.example/watch?v=x",
    ],
    [
      "https://evilyoutube.com/watch?v=abcdefghijk",
      "https://evilyoutube.com/watch?v=abcdefghijk",
    ],
    [
      "https://www.youtube.com./watch?v=abcdefghijk",
      "https://www.youtube.com/watch?v=abcdefghijk",
    ],
    [
      "https://gaming.youtube.com/watch?v=abcdefghijk",
      "https://www.youtube.com/watch?v=abcdefghijk",
    ],
    [
      "https://www.youtube.com/watch?v=abcdefghijk&t=5s",
      "https://www.youtube.com/watch?v=abcdefghijk",
    ],
    [
      "https://m.youtube.com/watch?v=abcdefghijk",
      "https://www.youtube.com/watch?v=abcdefghijk",
    ],
    [
      "https://music.youtube.com/watch?v=abcdefghijk&list=RD1",
      "https://music.youtube.com/watch?v=abcdefghijk",
    ],
    [
      "https://youtu.be/abcdefghijk?si=share",
      "https://www.youtube.com/watch?v=abcdefghijk",
    ],
    [
      "https://www.youtube.com/shorts/abcdefghijk",
      "https://www.youtube.com/shorts/abcdefghijk",
    ],
    [
      "https://page.example/post?id=1#comments",
      "https://page.example/post?id=1",
    ],
  ])("sends %s as %s", (href, url) => {
    expect(pickedLinkUrl(href)).toBe(url);
  });

  it.each([
    "https://x.com/home",
    "https://x.com/alice",
    "https://x.com/i/web/status/123",
    "https://x.com/alice/status/not-a-number",
    "https://twitter.com/search?q=video",
    "https://x.com./home",
    "https://mobile.x.com/home",
    "https://foo.twitter.com/alice",
    "https://t.co/abc",
    `https://page.example/post?id=${"1".repeat(2_030)}`,
    "https://www.youtube.com/@channel",
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/watch?list=PL1",
    "javascript:alert(1)",
    "https://user:secret@page.example/post",
    "/relative/path",
    "",
  ])("refuses %s", (href) => {
    expect(pickedLinkUrl(href)).toBeNull();
  });

  it("resolves a relative link against the page it was picked on", () => {
    expect(pickedLinkUrl("/alice/status/123", "https://x.com/home")).toBe(
      "https://x.com/alice/status/123",
    );
    expect(pickedLinkUrl("/home", "https://x.com/alice")).toBeNull();
  });
});

const X_PAGE = "https://x.com/home";

function pick(element: Element, base = X_PAGE) {
  return linkCandidateFor(
    element,
    base,
    (current) =>
      current !== document.body && current !== document.documentElement,
  );
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const created = document.createElement(tag);
  if (text !== undefined) created.textContent = text;
  return created;
}

/** A link to a profile or a post, with the time X puts in a permalink. */
function link(href: string, withTime = false): HTMLAnchorElement {
  const anchor = element("a");
  anchor.href = href;
  if (withTime) anchor.append(element("time", "2h"));
  return anchor;
}

function quoteCard(): HTMLDivElement {
  const card = element("div");
  card.setAttribute("role", "link");
  return card;
}

describe("X posts under the pointer", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("sends the quoted post from a timeline quote card with a permalink", () => {
    const post = element("article");
    post.append(link("/alice", false), link("/alice/status/1", true));
    const text = element("div", "Look at this");
    const quote = quoteCard();
    quote.append(link("https://x.com/carol/status/9", true));
    const quotedVideo = element("video");
    quote.append(quotedVideo);
    post.append(text, quote);
    document.body.append(post);

    expect(pick(quotedVideo)).toEqual({
      element: quote,
      url: "https://x.com/carol/status/9",
      host: "x.com",
    });
    // The outer post has no video of its own, so its text picks nothing.
    expect(pick(text)).toBeNull();
  });

  it("falls back to the outer post when the quote card has no permalink", () => {
    const post = element("article");
    post.append(link("/alice/status/1", true));
    const quote = quoteCard();
    quote.append(link("/carol", false), element("time", "3h"));
    const quotedVideo = element("video");
    quote.append(quotedVideo);
    post.append(quote);
    document.body.append(post);

    expect(pick(quotedVideo)).toEqual({
      element: post,
      url: "https://x.com/alice/status/1",
      host: "x.com",
    });
  });

  it("reads a post's own page, where the permalink sits at the bottom", () => {
    const post = element("article");
    const ownVideo = element("video");
    const quote = quoteCard();
    quote.append(link("/carol/status/9", true));
    const quotedVideo = element("video");
    quote.append(quotedVideo);
    post.append(
      link("/alice", false),
      element("div", "Mine"),
      ownVideo,
      quote,
      link("/alice/status/1", true),
    );
    document.body.append(post);

    expect(pick(ownVideo)).toMatchObject({
      element: post,
      url: "https://x.com/alice/status/1",
    });
    expect(pick(quotedVideo)).toMatchObject({
      element: quote,
      url: "https://x.com/carol/status/9",
    });
  });

  it("sends a nested inner article's own post", () => {
    const outer = element("article");
    outer.append(link("/alice/status/1", true));
    const text = element("div", "Quoting");
    const inner = element("article");
    inner.append(link("/dave/status/5", true));
    const innerVideo = element("video");
    inner.append(innerVideo);
    outer.append(text, inner);
    document.body.append(outer);

    expect(pick(innerVideo)).toMatchObject({
      element: inner,
      url: "https://x.com/dave/status/5",
    });
    expect(pick(text)).toBeNull();
  });

  it("sends the original post of a repost", () => {
    const post = element("article");
    const context = element("div");
    context.append(link("/bob", false), element("span", "Bob reposted"));
    const video = element("video");
    post.append(context, link("/alice/status/1", true), video);
    document.body.append(post);

    expect(pick(video)).toMatchObject({
      element: post,
      url: "https://x.com/alice/status/1",
    });
  });

  it("skips a status link without a time ahead of the post's permalink", () => {
    const post = element("article");
    const text = element("div");
    const mention = link("/bob/status/2", false);
    text.append(element("span", "See "), mention);
    const video = element("video");
    post.append(
      link("/alice", false),
      text,
      video,
      link("/alice/status/1", true),
    );
    document.body.append(post);

    expect(pick(video)).toMatchObject({
      element: post,
      url: "https://x.com/alice/status/1",
    });
    expect(pick(mention)).toMatchObject({
      url: "https://x.com/alice/status/1",
    });
  });

  it("sends nothing on X for a promoted post without a permalink or a bio link", () => {
    const promoted = element("article");
    const video = element("video");
    const promotedLink = link("https://t.co/promo", false);
    promoted.append(
      link("/brand", false),
      element("span", "Ad"),
      video,
      promotedLink,
    );
    const bio = element("div");
    const bioLink = link("https://t.co/abc", false);
    bio.append(bioLink);
    document.body.append(promoted, bio);

    expect(pick(video)).toBeNull();
    expect(pick(promotedLink)).toBeNull();
    expect(pick(bioLink)).toBeNull();
  });

  it("keeps a post with more than 32 links pickable", () => {
    const post = element("article");
    post.append(link("/alice/status/1", true));
    const video = element("video");
    post.append(video);
    for (let index = 0; index < 40; index += 1)
      post.append(link(`/hashtag/tag${index}`, false));
    document.body.append(post);

    expect(pick(video)).toMatchObject({
      url: "https://x.com/alice/status/1",
    });
  });

  it("sends only posts on X, but an ordinary link elsewhere", () => {
    const anchor = link("https://page.example/post?id=1", false);
    const inner = element("span", "Open");
    anchor.append(inner);
    document.body.append(anchor);

    expect(pick(inner)).toBeNull();
    expect(pick(inner, "https://page.example/")).toMatchObject({
      element: anchor,
      url: "https://page.example/post?id=1",
      host: "page.example",
    });
  });
});
