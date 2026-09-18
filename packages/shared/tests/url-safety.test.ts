import {
  UrlSafetyError,
  hasSensitiveUrlData,
  parseAllowedImageUrl,
  parseBackendBaseUrl,
  sanitizedImageFilename,
} from "../src/index.js";

describe("URL and filename safety", () => {
  it("allows HTTPS and loopback HTTP backend URLs", () => {
    expect(parseBackendBaseUrl("https://verify.example.test/base/").href).toBe(
      "https://verify.example.test/base",
    );
    expect(parseBackendBaseUrl("http://127.0.0.1:8787").origin).toBe(
      "http://127.0.0.1:8787",
    );
  });

  it.each([
    "http://public.example.test",
    "https://user:pass@example.test",
    "https://example.test?token=secret",
    "file:///tmp/socket",
  ])("rejects unsafe backend URLs", (value) => {
    expect(() => parseBackendBaseUrl(value)).toThrow(UrlSafetyError);
  });

  it("allows only supported image URL schemes", () => {
    expect(parseAllowedImageUrl("https://cdn.example/a.png?sig=1").search).toBe(
      "?sig=1",
    );
    expect(() => parseAllowedImageUrl("file:///etc/passwd")).toThrow(
      UrlSafetyError,
    );
    expect(() => parseAllowedImageUrl("javascript:alert(1)")).toThrow(
      UrlSafetyError,
    );
  });

  it("sanitizes filenames and never carries URL query data", () => {
    expect(sanitizedImageFilename("image/png", "../../evil<script>")).toBe(
      "evil-script.png",
    );
    expect(
      hasSensitiveUrlData("https://example.test/image.png?sig=secret"),
    ).toBe(true);
  });
});
