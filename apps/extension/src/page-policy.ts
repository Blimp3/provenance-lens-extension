export function isProtectedPage(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return true;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    (parsed.protocol === "https:" || parsed.protocol === "http:") &&
    (hostname === "chromewebstore.google.com" ||
      (hostname === "chrome.google.com" &&
        parsed.pathname.toLowerCase().startsWith("/webstore")))
  ) {
    return true;
  }

  return (
    /^(?:chrome|chrome-extension|brave|edge|about|view-source):/iu.test(
      value,
    ) || !/^https?:/iu.test(value)
  );
}
