import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOptionalAccessState: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getAll: vi.fn(),
  request: vi.fn(),
}));

vi.mock("../../src/bundled-client.js", () => ({
  getBundledClientTokenForBackend: vi.fn().mockReturnValue(null),
  isDefaultBackendUrl: vi.fn().mockReturnValue(false),
}));
vi.mock("../../src/storage.js", () => ({
  getSettings: mocks.getSettings,
  updateSettings: mocks.updateSettings,
}));
vi.mock("../../src/ui/optional-access.js", () => ({
  getOptionalAccessState: mocks.getOptionalAccessState,
  optionalAccessStatusText: vi.fn().mockReturnValue("Optional access is off."),
  requestFullOptionalAccess: vi.fn(),
}));

const settingsPage = readFileSync(
  resolve(import.meta.dirname, "../../public/settings.html"),
  "utf8",
);

describe("settings page", () => {
  beforeEach(async () => {
    vi.resetModules();
    // The real page, so its ids and the script stay in step.
    document.body.innerHTML = new DOMParser().parseFromString(
      settingsPage,
      "text/html",
    ).body.innerHTML;
    mocks.getSettings.mockReset().mockResolvedValue({
      verificationMode: "website",
      acknowledgedVerificationModes: ["website"],
      backendBaseUrl: "https://verify.example",
      clientToken: "",
      historyRetention: 20,
      localCacheLimit: 100,
      screenshotFallbackEnabled: false,
      includePageTitle: true,
      debugMode: false,
      disclosureVersion: 1,
    });
    mocks.updateSettings.mockReset().mockResolvedValue({});
    mocks.getOptionalAccessState.mockReset().mockResolvedValue({
      allSites: false,
      downloads: false,
      complete: false,
    });
    mocks.getAll.mockReset().mockResolvedValue({ origins: [] });
    mocks.request.mockReset().mockResolvedValue(true);
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        permissions: {
          getAll: mocks.getAll,
          request: mocks.request,
          onAdded: { addListener: vi.fn() },
          onRemoved: { addListener: vi.fn() },
        },
      },
    });

    await import("../../src/ui/settings.js");
    await vi.waitFor(() => expect(mocks.getSettings).toHaveBeenCalled());
  });

  it("keeps only the API connection and Extension access cards", () => {
    const headings = [...document.querySelectorAll("section > h2")].map(
      (heading) => heading.id,
    );
    expect(headings).toEqual(["connection-heading", "permissions-heading"]);
    // Every other group lives in the palette now.
    for (const id of [
      "verification-mode",
      "start-pairing",
      "history-retention",
      "local-cache-limit",
      "include-page-title",
      "debug-mode",
      "screenshot-fallback",
      "clear-history",
      "clear-cache",
      "refresh-permissions",
    ])
      expect(document.getElementById(id), id).toBeNull();
  });

  it("saves only the backend URL and client token", async () => {
    const backendUrl = document.getElementById("backend-url");
    const clientToken = document.getElementById("client-token");
    if (
      !(backendUrl instanceof HTMLInputElement) ||
      !(clientToken instanceof HTMLInputElement)
    )
      throw new Error("Missing input");
    backendUrl.value = "https://api.example/";
    clientToken.value = "client-token-value";

    document
      .getElementById("settings-form")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));

    await vi.waitFor(() =>
      expect(mocks.updateSettings).toHaveBeenCalledWith({
        backendBaseUrl: "https://api.example",
        clientToken: "client-token-value",
      }),
    );
  });

  it.each([
    "https://*",
    "https://*.example.com",
    "https://images.example/private/image.png",
  ])(
    "rejects an overbroad host input before requesting access: %s",
    async (value) => {
      const input = document.getElementById("permission-origin");
      if (!(input instanceof HTMLInputElement))
        throw new Error("Missing input");
      input.value = value;

      document.getElementById("request-permission")?.click();

      await vi.waitFor(() =>
        expect(
          document.getElementById("permission-status")?.textContent,
        ).toContain("one exact"),
      );
      expect(mocks.request).not.toHaveBeenCalled();
    },
  );

  it("requests only the exact origin pattern", async () => {
    const input = document.getElementById("permission-origin");
    if (!(input instanceof HTMLInputElement)) throw new Error("Missing input");
    input.value = "https://images.example";

    document.getElementById("request-permission")?.click();

    await vi.waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith({
        origins: ["https://images.example/*"],
      }),
    );
  });
});
