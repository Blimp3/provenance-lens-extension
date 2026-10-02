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
/** An X post, or the quote card inside one. */
const X_CARD_SELECTOR = 'article, div[role="link"]';
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/u;
const YOUTUBE_SHORTS_PATH = /^\/shorts\/([A-Za-z0-9_-]{11})\/?$/u;
const YOUTU_BE_PATH = /^\/([A-Za-z0-9_-]{11})\/?$/u;
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
