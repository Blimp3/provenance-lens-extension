import { beforeEach, describe, expect, it } from "vitest";

import {
  embedVideoUrl,
  linkCandidateFor,
  needsPostPick,
  pickedLinkUrl,
  pickedMediaUrl,
  postVideosAround,
  videoLinkFor,
  youtubeLinkAround,
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

describe("pages that start the post picker", () => {
  it.each([
    "https://x.com/",
    "https://x.com/home",
    "https://twitter.com/search?q=lens&f=live",
    "https://x.com/explore",
    "https://x.com/explore/tabs/for-you",
    "https://x.com/alice",
    "https://x.com/alice/media",
    "https://www.youtube.com/",
    "https://www.youtube.com/results?search_query=lens",
    "https://www.youtube.com/feed/subscriptions",
    "https://m.youtube.com/@channel",
    "https://www.youtube.com/@channel/videos",
    "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv",
    "https://www.youtube.com/c/name",
    "https://www.youtube.com/user/name/",
    "https://www.youtube.com/playlist?list=PL0123456789",
  ])("picks a post on the listing page %s", (pageUrl) => {
    expect(needsPostPick(pageUrl)).toBe(true);
  });

  it.each([
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL0123456789",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://music.youtube.com/playlist?list=PL0123456789",
    "https://www.youtube.com/live/dQw4w9WgXcQ",
    "https://www.youtube.com/clip/UgkxAbCdEfGhIjKlMnOpQrStUvWxYz",
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
    "https://x.com/alice/status/123",
    "https://x.com/alice/status/123/video/1",
    "https://x.com/i/web/status/123",
    "https://t.co/abc123",
    "https://news.example/story",
    "not a url",
  ])("sends %s as it is", (pageUrl) => {
    expect(needsPostPick(pageUrl)).toBe(false);
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

describe("download pick addresses", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("keeps an X post's /video/<n> only on the download pick's path", () => {
    expect(pickedMediaUrl("https://twitter.com/alice/status/123/video/3")).toBe(
      "https://x.com/alice/status/123/video/3",
    );
    expect(pickedMediaUrl("https://x.com/alice/status/123/video/4?s=20")).toBe(
      "https://x.com/alice/status/123/video/4",
    );
    expect(pickedLinkUrl("https://x.com/alice/status/123/video/3")).toBe(
      "https://x.com/alice/status/123",
    );
    // Anything else goes out as a picked link does.
    for (const href of [
      "https://x.com/alice/status/123/video/5",
      "https://x.com/alice/status/123/photo/1",
      "https://youtu.be/abcdefghijk",
      "https://page.example/post#top",
    ])
      expect(pickedMediaUrl(href)).toBe(pickedLinkUrl(href));
    expect(pickedMediaUrl("https://t.co/abc/video/1")).toBeNull();
    expect(pickedMediaUrl("https://x.com/home")).toBeNull();
  });

  /** An X post with its permalink and the given media in grid order. */
  function xPostWith(...media: Element[]): HTMLElement {
    const post = element("article");
    post.append(link("/alice/status/1", true), element("div", "A post"));
    for (const item of media) post.append(item);
    document.body.append(post);
    return post;
  }

  function photo(index: number, status = "/alice/status/1"): HTMLElement {
    const anchor = link(`${status}/photo/${index}`);
    anchor.append(element("img"));
    return anchor;
  }

  it("keeps the plain status while a post holds one video or GIF", () => {
    const video = element("video");
    xPostWith(photo(1), photo(2), video);
    expect(videoLinkFor(video, X_PAGE)).toBe("https://x.com/alice/status/1");
    document.body.replaceChildren();

    // X plays a GIF as a video too.
    const gif = element("video");
    xPostWith(photo(1), gif);
    expect(videoLinkFor(gif, X_PAGE)).toBe("https://x.com/alice/status/1");
    document.body.replaceChildren();

    const only = element("video");
    xPostWith(only);
    expect(videoLinkFor(only, X_PAGE)).toBe("https://x.com/alice/status/1");
  });

  it("names a video by the place its post's photo links leave free once the post holds two", () => {
    const first = element("video");
    const second = element("video");
    xPostWith(photo(1), photo(2), first, second);
    expect(videoLinkFor(first, X_PAGE)).toBe(
      "https://x.com/alice/status/1/video/3",
    );
    expect(videoLinkFor(second, X_PAGE)).toBe(
      "https://x.com/alice/status/1/video/4",
    );
    document.body.replaceChildren();

    const lead = element("video");
    const last = element("video");
    xPostWith(lead, photo(2), last);
    expect(videoLinkFor(lead, X_PAGE)).toBe(
      "https://x.com/alice/status/1/video/1",
    );
    expect(videoLinkFor(last, X_PAGE)).toBe(
      "https://x.com/alice/status/1/video/3",
    );
  });

  it("falls back to the grid order when the photo links do not fit", () => {
    const first = element("video");
    const second = element("video");
    xPostWith(photo(1), photo(1), first, second);
    expect(videoLinkFor(first, X_PAGE)).toBe(
      "https://x.com/alice/status/1/video/3",
    );
    expect(videoLinkFor(second, X_PAGE)).toBe(
      "https://x.com/alice/status/1/video/4",
    );
  });

  it("counts a quoted post's videos, but names a video only among its own post's media", () => {
    const quote = quoteCard();
    const quotedVideo = element("video");
    quote.append(link("https://x.com/carol/status/9", true), quotedVideo);
    const video = element("video");
    // A photo link of another status, such as a quoted post without a card.
    xPostWith(photo(1, "/carol/status/9"), quote, video);
    expect(videoLinkFor(video, X_PAGE)).toBe(
      "https://x.com/alice/status/1/video/1",
    );
    expect(videoLinkFor(quotedVideo, X_PAGE)).toBe(
      "https://x.com/carol/status/9",
    );
  });

  it("sends the plain status when the post shows a photo without its link", () => {
    /** A photo as X shows it, here without its /photo/<k> link. */
    const shownPhoto = (): HTMLImageElement => {
      const image = element("img");
      image.src = "https://pbs.twimg.com/media/abc123?format=jpg";
      return image;
    };
    const first = element("video");
    const second = element("video");
    xPostWith(shownPhoto(), first, second);
    expect(videoLinkFor(first, X_PAGE)).toBe("https://x.com/alice/status/1");
    expect(videoLinkFor(second, X_PAGE)).toBe("https://x.com/alice/status/1");
    document.body.replaceChildren();

    // A quote card with its own permalink, the same.
    const quote = quoteCard();
    const quotedFirst = element("video");
    const quotedSecond = element("video");
    quote.append(
      link("https://x.com/bob/status/9", true),
      shownPhoto(),
      quotedFirst,
      quotedSecond,
    );
    xPostWith(quote);
    expect(videoLinkFor(quotedSecond, X_PAGE)).toBe(
      "https://x.com/bob/status/9",
    );
    document.body.replaceChildren();

    // A photo inside its link, an avatar and a poster keep the places.
    const named = photo(1);
    named.querySelector("img")?.setAttribute("src", shownPhoto().src);
    const avatar = element("img");
    avatar.src = "https://pbs.twimg.com/profile_images/1/avatar.jpg";
    const poster = element("img");
    poster.src = "https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg";
    const lead = element("video");
    const last = element("video");
    xPostWith(avatar, named, poster, lead, last);
    expect(videoLinkFor(last, X_PAGE)).toBe(
      "https://x.com/alice/status/1/video/3",
    );
  });

  it("sends the outer post for a video in a quote card without its own permalink", () => {
    const quote = quoteCard();
    const quotedVideo = element("video");
    quote.append(element("div", "Quoted post"), quotedVideo);
    const video = element("video");
    xPostWith(photo(1), video, quote);
    expect(videoLinkFor(quotedVideo, X_PAGE)).toBe(
      "https://x.com/alice/status/1",
    );
    expect(videoLinkFor(video, X_PAGE)).toBe(
      "https://x.com/alice/status/1/video/2",
    );
  });

  it("sends a YouTube or Vimeo embed as its video's page, and nothing for another frame", () => {
    const base = "https://news.example/story";
    expect(
      [
        "https://www.youtube.com/embed/abcdefghijk?start=10",
        "https://www.youtube-nocookie.com/embed/abcdefghijk",
        "//youtube.com/embed/abcdefghijk/",
        "https://player.vimeo.com/video/76979871?h=8272103f6e",
        "https://player.vimeo.com/video/76979871?h=not-a-hash",
        "https://www.youtube.com/embed/videoseries?list=PL1",
        "https://www.youtube.com/embed/live_stream?channel=UC1234567890",
        "https://vimeo.com/76979871",
        "https://www.youtube.com.evil.example/embed/abcdefghijk",
        "https://ads.example/frame",
        "",
      ].map((src) => embedVideoUrl(src, base)),
    ).toEqual([
      "https://www.youtube.com/watch?v=abcdefghijk",
      "https://www.youtube.com/watch?v=abcdefghijk",
      "https://www.youtube.com/watch?v=abcdefghijk",
      // An unlisted video plays only with its hash.
      "https://vimeo.com/76979871/8272103f6e",
      "https://vimeo.com/76979871",
      null,
      // A channel's live stream names no video: the page goes out.
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("sends a video's own link elsewhere, and the page for none", () => {
    const anchor = link("https://page.example/watch/1#top");
    const linked = element("video");
    anchor.append(linked);
    const lone = element("video");
    const channel = link("https://www.youtube.com/@channel");
    const inChannel = element("video");
    channel.append(inChannel);
    document.body.append(anchor, lone, channel);
    const base = "https://page.example/";
    expect(videoLinkFor(linked, base)).toBe("https://page.example/watch/1");
    expect(videoLinkFor(lone, base)).toBeNull();
    expect(videoLinkFor(inChannel, base)).toBeNull();
    // On X a video outside a post is never sent by its link.
    expect(videoLinkFor(linked, X_PAGE)).toBeNull();
  });

  it("finds the videos of the post around a click on its text", () => {
    const video = element("video");
    const post = xPostWith(photo(1), video);
    const text = post.querySelector("div");
    if (!text) throw new Error("Missing text");
    expect(postVideosAround(text, X_PAGE)).toEqual([video]);

    const other = element("div", "Sidebar");
    document.body.append(other);
    expect(postVideosAround(other, X_PAGE)).toBeNull();

    const article = element("article");
    const story = element("p", "A story");
    const clip = element("video");
    article.append(story, clip);
    document.body.append(article);
    const base = "https://news.example/story";
    expect(postVideosAround(story, base)).toEqual([clip]);
    expect(postVideosAround(other, base)).toBeNull();
  });

  it("reads a YouTube thumbnail's video from its link", () => {
    const thumbnails = [
      "/watch?v=abcdefghijk&pp=feed",
      "https://www.youtube.com/shorts/abcdefghijk",
      "https://youtu.be/abcdefghijk",
      "https://www.youtube.com/@channel",
      "https://page.example/watch?v=abcdefghijk",
    ].map((href) => {
      const anchor = link(href);
      const image = element("img");
      anchor.append(image);
      document.body.append(anchor);
      return youtubeLinkAround(image, "https://www.youtube.com/");
    });
    expect(thumbnails).toEqual([
      "https://www.youtube.com/watch?v=abcdefghijk",
      "https://www.youtube.com/shorts/abcdefghijk",
      "https://www.youtube.com/watch?v=abcdefghijk",
      null,
      null,
    ]);
    expect(youtubeLinkAround(element("img"), "https://www.youtube.com/")).toBe(
      null,
    );
  });
});
