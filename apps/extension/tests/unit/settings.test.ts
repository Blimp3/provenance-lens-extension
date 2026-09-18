import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOptionalAccessState: vi.fn(),
  getSettings: vi.fn(),
  getAll: vi.fn(),
  request: vi.fn(),
}));

vi.mock("../../src/cache.js", () => ({
  clearVerificationCache: vi.fn(),
  setCacheLimit: vi.fn(),
}));
vi.mock("../../src/bundled-client.js", () => ({
  getBundledClientTokenForBackend: vi.fn().mockReturnValue(null),
  isDefaultBackendUrl: vi.fn().mockReturnValue(false),
}));
vi.mock("../../src/storage.js", () => ({
  clearHistory: vi.fn(),
  defaultSettings: {},
  getSettings: mocks.getSettings,
  saveSettings: vi.fn(),
}));
vi.mock("../../src/ui/optional-access.js", () => ({
  getOptionalAccessState: mocks.getOptionalAccessState,
  optionalAccessStatusText: vi.fn().mockReturnValue("Optional access is off."),
  requestFullOptionalAccess: vi.fn(),
}));

describe("settings exact-host permission", () => {
  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = `
      <form id="settings-form"></form>
      <select id="verification-mode"><option value="website">Website</option></select>
      <div id="website-mode-disclosure"></div>
      <div id="api-mode-disclosure"></div>
      <input id="backend-url">
      <input id="client-token">
      <select id="history-retention"><option value="20">20</option></select>
      <select id="local-cache-limit"><option value="100">100</option></select>
      <input id="include-page-title" type="checkbox">
      <input id="debug-mode" type="checkbox">
      <input id="screenshot-fallback" type="checkbox">
      <p id="connection-status"></p>
      <p id="history-status"></p>
      <p id="cache-status"></p>
      <input id="permission-origin">
      <p id="permission-status"></p>
      <button id="grant-optional-access"></button>
      <p id="optional-access-status"></p>
      <div id="bundled-client-disclosure"></div>
      <div id="backend-permission-note"></div>
      <button id="request-backend-permission"></button>
      <button id="test-connection"></button>
      <button id="clear-history"></button>
      <button id="clear-cache"></button>
      <button id="request-permission"></button>
      <button id="refresh-permissions"></button>
    `;
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
