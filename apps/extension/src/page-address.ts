/**
 * The page an action ran on, as Recent keeps it: only the origin and the
 * path, since a query can hold a code, a reset token or a signed link.
 */
export function pageAddress(url: string | undefined): string | null {
  const parsed = httpAddress(url);
  if (!parsed) return null;
  const address = `${parsed.origin}${parsed.pathname}`;
  return address.length <= 2_048 ? address : null;
}

/** An http(s) address, parsed; null for anything else. */
export function httpAddress(url: string | undefined): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(url ?? "");
  } catch {
    return null;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:"
    ? parsed
    : null;
}
