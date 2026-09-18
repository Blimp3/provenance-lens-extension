import { describe, expect, it } from "vitest";

import { isProtectedPage } from "../../src/page-policy.js";

describe("protected page policy", () => {
  it.each([
    "chrome://settings",
    "chrome-extension://id/popup.html",
    "about:blank",
    "file:///tmp/image.html",
    "https://chromewebstore.google.com/detail/example/abcdef",
    "https://chrome.google.com/webstore/detail/example/abcdef",
  ])("rejects %s", (url) => expect(isProtectedPage(url)).toBe(true));

  it.each([
    "https://example.com",
    "http://127.0.0.1:8787",
    "https://chrome.google.com/",
  ])("allows %s", (url) => expect(isProtectedPage(url)).toBe(false));
});
