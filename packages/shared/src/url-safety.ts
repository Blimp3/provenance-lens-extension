import { extensionForAudioMime, extensionForMime } from "./file-validation.js";
import type { SupportedAudioMime, SupportedImageMime } from "./schemas.js";

export class UrlSafetyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UrlSafetyError";
  }
}

export function parseBackendBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UrlSafetyError("Enter a valid backend URL.");
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new UrlSafetyError(
      "The backend URL cannot contain credentials, a query, or a fragment.",
    );
  }

  const isLoopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new UrlSafetyError(
      "Use HTTPS for remote backends. HTTP is allowed only for loopback development.",
    );
  }

  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url;
}

export function originPattern(url: URL): string {
  return `${url.origin}/*`;
}

export function parseAllowedImageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UrlSafetyError("The selected image URL is invalid.");
  }

  if (!["https:", "http:", "data:", "blob:"].includes(url.protocol)) {
    throw new UrlSafetyError("This image URL scheme is not supported.");
  }
  if (url.username || url.password) {
    throw new UrlSafetyError(
      "Image URLs containing credentials are not supported.",
    );
  }
  return url;
}

export function sanitizedImageFilename(
  mime: SupportedImageMime,
  seed = "selected-image",
): string {
  const base = seed
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .replace(/^[-._]+|[-._]+$/gu, "")
    .slice(0, 80);
  return `${base || "selected-image"}.${extensionForMime(mime)}`;
}

export function sanitizedAudioFilename(
  mime: SupportedAudioMime,
  seed = "selected-audio",
): string {
  const base = seed
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .replace(/^[-._]+|[-._]+$/gu, "")
    .slice(0, 80);
  return `${base || "selected-audio"}.${extensionForAudioMime(mime)}`;
}

export function hasSensitiveUrlData(value: string): boolean {
  try {
    const url = new URL(value);
    return Boolean(url.search || url.hash || url.username || url.password);
  } catch {
    return true;
  }
}
