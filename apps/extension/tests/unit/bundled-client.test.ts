import { describe, expect, it } from "vitest";

import {
  applyBundledClientToken,
  getBundledClientTokenForBackend,
  isDefaultBackendUrl,
} from "../../src/bundled-client.js";
import { defaultSettings } from "../../src/storage.js";

const productionBackend = "https://provenance-backend.example.invalid";

describe("bundled client configuration", () => {
  it("recognizes only the production backend, including a trailing slash", () => {
    expect(isDefaultBackendUrl(productionBackend)).toBe(true);
    expect(isDefaultBackendUrl(`${productionBackend}/`)).toBe(true);
    expect(isDefaultBackendUrl("https://verify.example")).toBe(false);
  });

  it("replaces a stale token only for the production backend", () => {
    expect(
      applyBundledClientToken(
        { ...defaultSettings, backendBaseUrl: productionBackend },
        "bundled-token",
      ).clientToken,
    ).toBe("bundled-token");
    expect(
      applyBundledClientToken(
        { ...defaultSettings, backendBaseUrl: "https://verify.example" },
        "bundled-token",
      ).clientToken,
    ).toBe(defaultSettings.clientToken);
  });

  it("does not expose a bundled token to a custom backend", () => {
    expect(
      getBundledClientTokenForBackend(
        "https://verify.example",
        "bundled-token",
      ),
    ).toBe("");
  });
});
