/**
 * Link candidates for the video picker. A candidate is the element under the
 * pointer that stands for one post or page DigiBot can download, with the one
 * address sent for it:
 *
 * - On X (`x.com`, `twitter.com` and their subdomains; `t.co` counts as X)
 *   nothing but a post is ever sent. The post is the smallest card around the
 *   pointer, an `article` or a `div[role="link"]` quote card, that has its own
 *   permalink, a time-wrapped link to `/<user>/status/<id>`: a quote card with
 *   a permalink sends the quoted post, and the outer post only when the quote
 *   card has none. A post is pickable only while it shows a rendered `<video>`
 *   of its own, and its link is sent canonicalised as
 *   `https://x.com/<user>/status/<id>`. The timeline, a profile, a search
 *   page, a `t.co` link or a promoted card without a permalink gives nothing.
 * - A YouTube card is the nearest ancestor whose links name exactly one
 *   `/watch?v=` or `/shorts/` video; a container holding two gives nothing.
 * - Anywhere else, the nearest HTTP(S) link is sent without its fragment.
 *
 * The download pick reuses these rules for a clicked video: on X its post,
 * with `/video/<n>` when the post holds two or more videos, elsewhere the
 * link around the video, else the page's own address. A YouTube or Vimeo
 * embed is sent as its video's own page.
 *
 * Hosts match by suffix once trailing dots are stripped. The functions take
 * the base address explicitly, so the background can re-validate a picked
 * address without a document.
 */

export type LinkCandidate = { element: Element; url: string; host: string };

/** The longest address the picker sends; the message schema refuses more. */
const MAX_LINK_LENGTH = 2_048;
const X_HOST = /(^|\.)(x|twitter)\.com$/u;
const YOUTUBE_HOST = /(^|\.)youtube\.com$/u;
const X_STATUS_PATH = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})(?:\/|$)/u;
/** A photo of an X post; X posts hold at most four media items. */
const X_PHOTO_PATH =
  /^\/[A-Za-z0-9_]{1,15}\/status\/\d{1,25}\/photo\/([1-4])\/?$/u;
const X_VIDEO_PATH =
  /^\/[A-Za-z0-9_]{1,15}\/status\/\d{1,25}\/video\/([1-4])\/?$/u;
/** An X post, or the quote card inside one. */
const X_CARD_SELECTOR = 'article, div[role="link"]';
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/u;
const YOUTUBE_SHORTS_PATH = /^\/shorts\/([A-Za-z0-9_-]{11})\/?$/u;
const YOUTU_BE_PATH = /^\/([A-Za-z0-9_-]{11})\/?$/u;
const YOUTUBE_EMBED_HOST = /(^|\.)youtube(-nocookie)?\.com$/u;
const YOUTUBE_EMBED_PATH = /^\/embed\/([A-Za-z0-9_-]{11})\/?$/u;
const VIMEO_PLAYER_PATH = /^\/video\/(\d{1,12})\/?$/u;
// An unlisted Vimeo video's player carries its hash as ?h=.
const VIMEO_HASH = /^[0-9a-f]{6,40}$/iu;
// YouTube embeds whose 11-character name is not a video id.
const YOUTUBE_EMBED_NAMES = new Set(["videoseries", "live_stream"]);
/** X home, search, explore, or a profile and its media, replies or likes tab. */
const X_LISTING_PATH =
  /^\/(?:home|search|explore(?:\/.*)?|[A-Za-z0-9_]{1,15}(?:\/(?:media|with_replies|likes|highlights))?)?\/?$/u;
/** YouTube home, search results, a feed, a channel or a playlist. */
const YOUTUBE_LISTING_PATH =
  /^\/(?:results|playlist|feed(?:\/.*)?|@[^/]+(?:\/.*)?|(?:channel|c|user)\/[^/]+(?:\/.*)?)?\/?$/u;
/** More links than any card has; a container this large is not one post. */
const MAX_CARD_LINKS = 32;

/**
 * The address a picked link is sent as, or null when it must not be sent: an
 * X address that is not a post, a YouTube address that is not one video, or
 * anything but a credential-free HTTP(S) URL of at most 2,048 characters.
 */
export function pickedLinkUrl(href: string, base?: string): string | null {
  const url = resolveHttpUrl(href, base);
  if (!url) return null;
  const host = hostOf(url);
  if (isXHost(host)) return xStatusUrl(url);
  if (isYouTubeHost(host)) return youtubeVideoUrl(url);
  return url.toString();
}

/**
 * The address a download pick sends for a picked video: as pickedLinkUrl,
 * but an X post's `/video/<n>` suffix stays, so DigiBot sends that video of
 * a post with several media items.
 */
export function pickedMediaUrl(href: string, base?: string): string | null {
  const url = resolveHttpUrl(href, base);
  if (!url) return null;
  const status = isXHost(hostOf(url)) ? xStatusUrl(url) : null;
  const index = X_VIDEO_PATH.exec(url.pathname)?.[1];
  return status !== null && index !== undefined
    ? `${status}/video/${index}`
    : pickedLinkUrl(href, base);
}

/**
 * Whether a page's own address is a listing page, whose video is sent by
 * picking a post there: X home, search, explore or a profile, or YouTube
 * home, search results, a feed, a channel or a playlist. Every other page,
 * a post, a video, a live or clip page or a YouTube Music page among them,
 * is sent as it is.
 */
export function needsPostPick(pageUrl: string): boolean {
  const url = resolveHttpUrl(pageUrl, undefined);
  if (!url) return false;
  const host = hostOf(url);
  if (X_HOST.test(host)) return X_LISTING_PATH.test(url.pathname);
  if (YOUTUBE_HOST.test(host) && host !== "music.youtube.com") {
    return YOUTUBE_LISTING_PATH.test(url.pathname);
  }
  return false;
}

/**
 * Climbs from the element under the pointer while `visit` allows it and
 * returns the first candidate, or null when the chain holds none.
 */
export function linkCandidateFor(
  start: Element,
  base: string,
  visit: (element: Element) => boolean,
): LinkCandidate | null {
  // The post around the pointer is settled once, before any climb, so a post
  // is pickable however many links its text holds.
  const post = xPostCandidate(start, base);
  if (post !== undefined) return post;
  // On X nothing but a post is sent: a bio or promoted link never climbs.
  if (isXPage(base)) return null;
  let current: Element | null = start;
  while (current && visit(current)) {
    const found = candidateAtLevel(current, base);
    if (found !== undefined) return found;
    current = current.parentElement;
  }
  return null;
}

/**
 * The address a download pick sends for a rendered video, or null for the
 * page's own address. On X that is the video's post. DigiBot's downloader
 * sends a post's address as its one video or GIF, its quoted post's
 * included, and refuses a post with more as a playlist, while
 * `/video/<n>` names the post's n-th media item, photos counted, and must be
 * a video. So a post with two or more videos names the clicked one as
 * `/video/<n>`, and a video in a quote card without its own permalink sends
 * the outer post. Elsewhere it is the link around the video.
 */
export function videoLinkFor(video: Element, base: string): string | null {
  const post = xPostAround(video, base);
  if (post) {
    if (cardOf(video) !== post.card) return post.status;
    if (post.card.querySelectorAll("video").length < 2) return post.status;
    const place = xMediaPlace(post, video, base);
    return place === null ? post.status : `${post.status}/video/${place}`;
  }
  if (isXPage(base)) return null;
  const link = video.closest("a[href]");
  return link ? pickedLinkUrl(link.getAttribute("href") ?? "", base) : null;
}

/**
 * The page of the video a YouTube or Vimeo embed plays, or null for any
 * other frame: `youtube.com/embed/<id>` and `youtube-nocookie.com/embed/<id>`
 * as `https://www.youtube.com/watch?v=<id>`, `player.vimeo.com/video/<id>`
 * as `https://vimeo.com/<id>`, with an unlisted video's `?h=<hash>` as
 * `https://vimeo.com/<id>/<hash>`. A playlist or a channel's live stream
 * embed names no video.
 */
export function embedVideoUrl(src: string, base: string): string | null {
  const url = resolveHttpUrl(src, base);
  if (!url) return null;
  const host = hostOf(url);
  if (YOUTUBE_EMBED_HOST.test(host)) {
    const id = YOUTUBE_EMBED_PATH.exec(url.pathname)?.[1];
    // /embed/videoseries?list= and /embed/live_stream?channel= look like ids.
    return id === undefined || YOUTUBE_EMBED_NAMES.has(id)
      ? null
      : `https://www.youtube.com/watch?v=${id}`;
  }
  if (host === "player.vimeo.com") {
    const id = VIMEO_PLAYER_PATH.exec(url.pathname)?.[1];
    if (id === undefined) return null;
    const hash = url.searchParams.get("h") ?? "";
    return VIMEO_HASH.test(hash)
      ? `https://vimeo.com/${id}/${hash.toLowerCase()}`
      : `https://vimeo.com/${id}`;
  }
  return null;
}

/**
 * The videos of the post around an element, for a download pick on a post's
 * text or empty area: on X the post with its own permalink, elsewhere the
 * nearest `article`. null outside a post.
 */
export function postVideosAround(
  element: Element,
  base: string,
): Element[] | null {
  const post = xPostAround(element, base);
  if (post)
    return xPostMedia(post, base).filter(
      (media) => media.localName === "video",
    );
  if (isXPage(base)) return null;
  const article = element.closest('article, [role="article"]');
  return article ? Array.from(article.querySelectorAll("video")) : null;
}

/** The YouTube video a thumbnail's link names, or null. */
export function youtubeLinkAround(
  element: Element,
  base: string,
): string | null {
  const link = element.closest("a[href]");
  const url = link
    ? resolveHttpUrl(link.getAttribute("href") ?? "", base)
    : null;
  return url && isYouTubeHost(hostOf(url)) ? youtubeVideoUrl(url) : null;
}

/** undefined: keep climbing; null: stop with nothing; otherwise the candidate. */
function candidateAtLevel(
  element: Element,
  base: string,
): LinkCandidate | null | undefined {
  if (element.localName === "a") {
    const url = resolveHttpUrl(element.getAttribute("href") ?? "", base);
    if (url) {
      const host = hostOf(url);
      // An X link outside a post is never a pickable post.
      if (isXHost(host)) return null;
      if (isYouTubeHost(host)) {
        const video = youtubeVideoUrl(url);
        // A channel or another YouTube link: the card above decides.
        return video === null ? undefined : candidate(element, video);
      }
      return candidate(element, url.toString());
    }
  }
  const links = Array.from(element.querySelectorAll("a[href]"));
  if (links.length > MAX_CARD_LINKS) return null;
  const videos = new Set<string>();
  for (const link of links) {
    const url = resolveHttpUrl(link.getAttribute("href") ?? "", base);
    const video = url ? youtubeVideoUrl(url) : null;
    if (video !== null) videos.add(video);
  }
  if (videos.size > 1) return null;
  const [video] = videos;
  return video === undefined ? undefined : candidate(element, video);
}

type XPost = { card: Element; status: string };

/**
 * undefined when the element is not inside an X post; null for a post without
 * a rendered video of its own; otherwise the post with its canonical address.
 */
function xPostCandidate(
  start: Element,
  base: string,
): LinkCandidate | null | undefined {
  const post = xPostAround(start, base);
  if (!post) return undefined;
  const ownVideo = Array.from(post.card.querySelectorAll("video")).some(
    (video) => xPostAround(video, base)?.card === post.card,
  );
  return ownVideo ? candidate(post.card, post.status) : null;
}

/** The smallest card around the element that has its own permalink. */
function xPostAround(element: Element, base: string): XPost | null {
  for (let card = cardOf(element); card; card = cardOf(card.parentElement)) {
    const status = ownStatusLink(card, base);
    if (status !== null) return { card, status };
  }
  return null;
}

/** The post's own videos and photos of its own status, in document order. */
function xPostMedia(post: XPost, base: string): Element[] {
  return Array.from(
    post.card.querySelectorAll('video, a[href*="/photo/"]'),
  ).filter(
    (element) =>
      xPostAround(element, base)?.card === post.card &&
      (element.localName === "video" || xPhotoPlace(element, post, base) > 0),
  );
}

/** The k of a photo link `/photo/<k>` of the post's own status, else 0. */
function xPhotoPlace(link: Element, post: XPost, base: string): number {
  const url = resolveHttpUrl(link.getAttribute("href") ?? "", base);
  if (!url || !isXHost(hostOf(url))) return 0;
  const place = X_PHOTO_PATH.exec(url.pathname)?.[1];
  return place !== undefined &&
    xStatusUrl(url)?.toLowerCase() === post.status.toLowerCase()
    ? Number(place)
    : 0;
}

/**
 * A video's 1-based place among the post's own media, a quote card's left
 * out. A photo link names its place among all of them (`/photo/<k>`), so
 * the videos take the places the photo links leave free, in document order;
 * when the photo links do not fit, the place is the document order. null
 * past four, and null when the post shows a photo without its link: its
 * place is then unknown, so the plain status goes out and DigiBot refuses
 * it as a playlist rather than send another video.
 */
function xMediaPlace(post: XPost, video: Element, base: string): number | null {
  const media = xPostMedia(post, base).filter(
    (element) => cardOf(element) === post.card,
  );
  const unnamedPhoto = Array.from(post.card.querySelectorAll("img")).some(
    (image) =>
      cardOf(image) === post.card &&
      isXPhoto(image, base) &&
      !media.some(
        (element) => element.localName !== "video" && element.contains(image),
      ),
  );
  if (unnamedPhoto) return null;
  const videos = media.filter((element) => element.localName === "video");
  const taken = new Set(
    media
      .filter((element) => element.localName !== "video")
      .map((link) => xPhotoPlace(link, post, base)),
  );
  const free = [1, 2, 3, 4].filter((place) => !taken.has(place));
  const fits =
    taken.size === media.length - videos.length && free.length >= videos.length;
  const place = fits ? free[videos.indexOf(video)] : media.indexOf(video) + 1;
  return place !== undefined && place >= 1 && place <= 4 ? place : null;
}

/** A post's photo, not an avatar, an emoji or a video's poster. */
function isXPhoto(image: Element, base: string): boolean {
  const url = resolveHttpUrl(image.getAttribute("src") ?? "", base);
  return (
    url !== null &&
    hostOf(url) === "pbs.twimg.com" &&
    url.pathname.startsWith("/media/")
  );
}

function cardOf(element: Element | null): Element | null {
  return element?.closest(X_CARD_SELECTOR) ?? null;
}

/** The card's time-wrapped status link, not one of a card nested in it. */
function ownStatusLink(card: Element, base: string): string | null {
  for (const anchor of Array.from(
    card.querySelectorAll('a[href*="/status/"]'),
  )) {
    if (!anchor.querySelector("time") || cardOf(anchor) !== card) continue;
    const url = resolveHttpUrl(anchor.getAttribute("href") ?? "", base);
    const status = url && isXHost(hostOf(url)) ? xStatusUrl(url) : null;
    if (status !== null) return status;
  }
  return null;
}

function xStatusUrl(url: URL): string | null {
  const match = X_STATUS_PATH.exec(url.pathname);
  const user = match?.[1];
  const id = match?.[2];
  return user !== undefined && id !== undefined
    ? `https://x.com/${user}/status/${id}`
    : null;
}

function isXPage(base: string): boolean {
  try {
    return isXHost(hostOf(new URL(base)));
  } catch {
    return false;
  }
}

/** The hostname in lower case without any trailing dots. */
function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.+$/u, "");
}

function isXHost(host: string): boolean {
  return host === "t.co" || X_HOST.test(host);
}

function isYouTubeHost(host: string): boolean {
  return host === "youtu.be" || YOUTUBE_HOST.test(host);
}

function youtubeVideoUrl(url: URL): string | null {
  const host = hostOf(url);
  if (host === "youtu.be") {
    const id = YOUTU_BE_PATH.exec(url.pathname)?.[1];
    return id === undefined ? null : `https://www.youtube.com/watch?v=${id}`;
  }
  if (!YOUTUBE_HOST.test(host)) return null;
  const shorts = YOUTUBE_SHORTS_PATH.exec(url.pathname)?.[1];
  if (shorts !== undefined) return `https://www.youtube.com/shorts/${shorts}`;
  if (url.pathname !== "/watch") return null;
  const id = url.searchParams.get("v");
  if (id === null || !YOUTUBE_VIDEO_ID.test(id)) return null;
  // YouTube Music keeps its host, since DigiBot sends M4A audio for it.
  const canonicalHost = host === "music.youtube.com" ? host : "www.youtube.com";
  return `https://${canonicalHost}/watch?v=${id}`;
}

function resolveHttpUrl(href: string, base: string | undefined): URL | null {
  const trimmed = href.trim();
  if (!trimmed || trimmed.length > MAX_LINK_LENGTH) return null;
  let url: URL;
  try {
    url = base === undefined ? new URL(trimmed) : new URL(trimmed, base);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== ""
  )
    return null;
  // The fragment never reaches a server and can carry tokens or share keys.
  url.hash = "";
  return url.toString().length > MAX_LINK_LENGTH ? null : url;
}

function candidate(element: Element, url: string): LinkCandidate {
  return { element, url, host: new URL(url).hostname };
}
