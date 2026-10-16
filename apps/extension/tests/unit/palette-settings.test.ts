import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as IntegrationClient from "../../src/integration-client.js";
import type * as OptionalAccess from "../../src/ui/optional-access.js";

const mocks = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  setCacheLimit: vi.fn(),
  clearVerificationCache: vi.fn(),
  clearHistory: vi.fn(),
  exchangePairing: vi.fn(),
  requestFullOptionalAccess: vi.fn(),
}));

vi.mock("../../src/cache.js", () => ({
  clearVerificationCache: mocks.clearVerificationCache,
  setCacheLimit: mocks.setCacheLimit,
}));
vi.mock("../../src/storage.js", () => ({
  clearHistory: mocks.clearHistory,
  defaultSettings: {
    verificationMode: "website",
    acknowledgedVerificationModes: [],
    backendBaseUrl: "https://verify.example",
    clientToken: "",
    historyRetention: 20,
    screenshotFallbackEnabled: false,
    includePageTitle: true,
    debugMode: false,
    localCacheLimit: 100,
    disclosureVersion: 0,
  },
  updateSettings: mocks.updateSettings,
}));
vi.mock("../../src/integration-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof IntegrationClient>()),
  exchangePairing: mocks.exchangePairing,
  getIntegrationSession: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../src/ui/optional-access.js", async (importOriginal) => ({
  ...(await importOriginal<typeof OptionalAccess>()),
  requestFullOptionalAccess: mocks.requestFullOptionalAccess,
}));

import { IntegrationClientError } from "../../src/integration-client.js";
import { copyThroughOffscreen } from "../../src/offscreen-copy.js";
import { checkAlias, effectiveAliases } from "../../src/ui/palette-commands.js";
import {
  allowSite,
  checkSiteOrigin,
  confirmFor,
  CONNECT_CONSENT,
  CONNECT_INTRO,
  COPY_HINT_MAC,
  copyText,
  defaultFor,
  finishSetupItems,
  MODE_DISCLOSURES,
  openTabPage,
  PAIRING_LIMIT_MS,
  pairingStartedAt,
  pickPaletteSettings,
  pollPairing,
  saveSetting,
  settingsItems,
  type ConfirmView,
  type SettingsState,
} from "../../src/ui/palette-settings.js";

const TOKEN = "bundled-or-typed-client-token-0123456789";
const stored = {
  verificationMode: "api" as const,
  acknowledgedVerificationModes: ["api" as const],
  backendBaseUrl: "https://verify.example",
  clientToken: TOKEN,
  historyRetention: 20 as const,
  screenshotFallbackEnabled: false,
  includePageTitle: true,
  debugMode: false,
  localCacheLimit: 100,
  disclosureVersion: 1,
};

function state(overrides: Partial<SettingsState> = {}): SettingsState {
  return {
    settings: pickPaletteSettings(stored),
    connected: false,
    optionalAccess: { allSites: false, downloads: false, complete: false },
    grantedSites: ["https://images.example/*"],
    paletteShortcut: ["⌥", "⇧", "Space"],
    version: "2.1.0",
    ...overrides,
  };
}

function notReady(): IntegrationClientError {
  return new IntegrationClientError(
    "Approve this pairing in DigiBot, then try again.",
    "pairing_not_ready",
    true,
    409,
  );
}

function installChrome(extra: Record<string, unknown> = {}) {
  const api = {
    runtime: {
      getURL: (path: string) => `chrome-extension://test/${path}`,
      sendMessage: vi.fn(),
      getContexts: vi.fn().mockResolvedValue([]),
    },
    permissions: { request: vi.fn(), getAll: vi.fn() },
    tabs: { create: vi.fn().mockResolvedValue({}) },
    offscreen: { createDocument: vi.fn().mockResolvedValue(undefined) },
    ...extra,
  };
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: api,
  });
  return api;
}

beforeEach(() => {
  mocks.updateSettings.mockImplementation((update: object) =>
    Promise.resolve({ ...stored, ...update }),
  );
  mocks.setCacheLimit.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("palette settings save on change", () => {
  it("saves only the changed setting at once and keeps the rest", async () => {
    installChrome();
    const next = await saveSetting({ includePageTitle: false });
    expect(mocks.updateSettings).toHaveBeenCalledWith({
      includePageTitle: false,
    });
    expect(next.includePageTitle).toBe(false);
    expect(mocks.setCacheLimit).not.toHaveBeenCalled();
  });

  it("trims the local cache when its limit changes", async () => {
    installChrome();
    await saveSetting({ localCacheLimit: 250 });
    expect(mocks.updateSettings).toHaveBeenCalledWith({
      localCacheLimit: 250,
    });
    expect(mocks.setCacheLimit).toHaveBeenCalledWith(250);
  });

  it("never passes the backend URL or the client token on", async () => {
    installChrome();
    await saveSetting({
      debugMode: true,
      clientToken: "typed",
      backendBaseUrl: "https://other.example",
    } as never);
    expect(mocks.updateSettings).toHaveBeenCalledWith({ debugMode: true });
  });

  it("resets a setting to its default", () => {
    expect(defaultFor("historyRetention")).toEqual({ historyRetention: 20 });
    expect(defaultFor("verificationMode")).toEqual({
      verificationMode: "website",
    });
  });
});

describe("palette settings without the API connection", () => {
  it("shows no API connection row and never the client token", () => {
    const items = settingsItems(state());
    const titles = items.map(({ title }) => title);
    for (const title of [
      "Backend URL",
      "Client token",
      "Test connection",
      "Allow backend access",
    ])
      expect(titles).not.toContain(title);
    expect(JSON.stringify(items)).not.toContain(TOKEN);
    expect(Object.keys(pickPaletteSettings(stored)).sort()).toEqual([
      "debugMode",
      "historyRetention",
      "includePageTitle",
      "localCacheLimit",
      "screenshotFallbackEnabled",
      "verificationMode",
    ]);
  });

  it("reads no backend field in the palette's own code", async () => {
    for (const file of ["src/ui/palette.ts", "src/ui/palette-settings.ts"]) {
      const source = await readFile(
        resolve(import.meta.dirname, "../..", file),
        "utf8",
      );
      expect(source).not.toMatch(
        /clientToken|backendBaseUrl|testConnection|requestBackendAccess/u,
      );
    }
  });

  it("ends with Advanced settings, which opens settings.html in a tab", async () => {
    const api = installChrome();
    const last = settingsItems(state()).at(-1);
    expect(last).toMatchObject({
      title: "Advanced settings",
      subtitle: "Backend URL, client token, connection test",
      run: { kind: "tab", page: "advanced" },
    });
    await openTabPage("advanced");
    expect(api.tabs.create).toHaveBeenCalledWith({
      url: "chrome-extension://test/settings.html",
    });
  });

  it("lists every group of the Settings view in order", () => {
    expect([
      ...new Set(settingsItems(state()).map(({ group }) => group)),
    ]).toEqual([
      "DigiBot",
      "Verification",
      "History and privacy",
      "Access",
      "Keys",
      "About",
      "More",
    ]);
    expect(
      settingsItems(state()).find(({ title }) => title === "Version"),
    ).toMatchObject({ value: "2.1.0", subtitle: "Lens never scans pages." });
  });
});

describe("palette settings validation", () => {
  it("allows one exact credential-free HTTP(S) origin with today's messages", () => {
    expect(checkSiteOrigin("images.example")).toEqual({
      ok: false,
      message: "Enter a valid HTTP or HTTPS origin.",
    });
    for (const text of [
      "ftp://images.example",
      "https://user:secret@images.example",
      "https://*.images.example",
      "https://images.example/photos",
      "https://images.example/?size=1",
      "https://images.example/#top",
    ])
      expect(checkSiteOrigin(text)).toEqual({
        ok: false,
        message:
          "Enter one exact credential-free HTTP(S) origin without a wildcard or path.",
      });
    expect(checkSiteOrigin(" https://images.example ")).toEqual({
      ok: true,
      origin: "https://images.example",
      pattern: "https://images.example/*",
    });
  });

  it("asks the browser for the site first and reports each answer", async () => {
    const api = installChrome();
    const site = checkSiteOrigin("https://images.example");
    if (!site.ok) throw new Error("expected a valid origin");
    api.permissions.request.mockResolvedValueOnce(true);
    await expect(allowSite(site)).resolves.toEqual({
      ok: true,
      message: "Access granted for https://images.example.",
    });
    expect(api.permissions.request).toHaveBeenCalledWith({
      origins: ["https://images.example/*"],
    });
    api.permissions.request.mockResolvedValueOnce(false);
    await expect(allowSite(site)).resolves.toEqual({
      ok: false,
      message: "Host access was not granted.",
    });
    api.permissions.request.mockRejectedValueOnce(new Error("no gesture"));
    await expect(allowSite(site)).resolves.toEqual({
      ok: false,
      message: "The browser denied the permission request.",
    });
  });

  it("keeps the alias rule and its error text", () => {
    const aliases = effectiveAliases({ aliases: {}, lastUsed: [] });
    expect(checkAlias("D!", "open-history", aliases)).toEqual({
      ok: false,
      message: "1 to 12 characters: a–z, 0–9 and -.",
    });
    expect(checkAlias("d", "open-history", aliases)).toEqual({
      ok: false,
      message: "Already used by Send video",
    });
    expect(checkAlias("", "send-page-video", aliases)).toEqual({
      ok: true,
      alias: null,
    });
  });

  it("shows today's two disclosure lines for the verification mode", async () => {
    const html = await readFile(
      resolve(import.meta.dirname, "../../public/settings.html"),
      "utf8",
    );
    document.body.innerHTML = html;
    const text = (id: string) =>
      document.getElementById(id)?.textContent?.replace(/\s+/gu, " ").trim();
    expect(MODE_DISCLOSURES).toEqual([
      text("website-mode-disclosure"),
      text("api-mode-disclosure"),
    ]);
    // Card 3, word for word.
    const card = document
      .getElementById("integration-heading")
      ?.closest("section");
    const paragraphs = [...(card?.querySelectorAll("p.muted") ?? [])].map(
      (paragraph) => paragraph.textContent?.replace(/\s+/gu, " ").trim(),
    );
    expect(paragraphs.slice(0, 2)).toEqual([CONNECT_INTRO, CONNECT_CONSENT]);
  });
});

describe("palette Confirm views", () => {
  it("puts Cancel first and the danger action second", () => {
    for (const view of [
      "disconnect",
      "clear-history",
      "clear-cache",
      "reset-aliases",
    ] satisfies ConfirmView[]) {
      const { choices } = confirmFor(view, 3);
      expect(choices[0]).toEqual({ title: "Cancel", danger: false });
      expect(choices[1].danger).toBe(true);
    }
    expect(confirmFor("clear-history", 23).message).toBe(
      "Clear 23 saved results? This cannot be undone.",
    );
  });
});

describe("palette Finish setup", () => {
  const base = {
    connected: false,
    pairingPending: false,
    optionalAccess: { allSites: true, downloads: true, complete: true },
    paletteShortcut: "⌥⇧Space",
  };

  it("shows Complete DigiBot pairing while a pairing is pending", () => {
    expect(
      finishSetupItems({ ...base, pairingPending: true }).map(
        ({ title }) => title,
      ),
    ).toEqual(["Complete DigiBot pairing"]);
    expect(finishSetupItems(base).map(({ title }) => title)).toEqual([
      "Connect DigiBot",
    ]);
    expect(
      finishSetupItems({ ...base, connected: true, pairingPending: true }),
    ).toEqual([]);
  });

  it("lists only the missing items", () => {
    expect(
      finishSetupItems({
        ...base,
        connected: true,
        optionalAccess: { allSites: false, downloads: true, complete: false },
        paletteShortcut: "",
      }).map(({ title }) => title),
    ).toEqual(["Grant optional access", "Choose a palette shortcut"]);
  });
});

describe("palette pairing poll", () => {
  it("asks every 3 s, then every 30 s, and stops at 5 minutes", async () => {
    vi.useFakeTimers();
    const exchange = vi.fn().mockRejectedValue(notReady());
    const poll = pollPairing({ startedAt: Date.now(), exchange });
    let outcome: string | undefined;
    void poll.done.then((value) => {
      outcome = value;
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(exchange).toHaveBeenCalledTimes(10);
    await vi.advanceTimersByTimeAsync(PAIRING_LIMIT_MS - 30_000);
    expect(outcome).toBe("timeout");
    const calls = exchange.mock.calls.length;
    // Under DigiBot's 20 exchange requests per address in 10 minutes.
    expect(calls).toBeLessThan(20);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(exchange).toHaveBeenCalledTimes(calls);
  });

  it("completes once DigiBot approves and stops on an expired pairing", async () => {
    vi.useFakeTimers();
    const approved = vi
      .fn()
      .mockRejectedValueOnce(notReady())
      .mockResolvedValueOnce({});
    const first = pollPairing({ startedAt: Date.now(), exchange: approved });
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(first.done).resolves.toBe("connected");

    const expired = vi
      .fn()
      .mockRejectedValue(
        new IntegrationClientError("Expired.", "pairing_expired", false),
      );
    const second = pollPairing({
      startedAt: Date.now(),
      exchange: expired,
      immediate: true,
    });
    await expect(second.done).resolves.toBe("timeout");
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("resumes a stored pairing on its own clock and stops on request", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const expiresAt = new Date(now + 60_000).toISOString();
    expect(pairingStartedAt(expiresAt, now)).toBe(now - 240_000);
    const exchange = vi.fn().mockRejectedValue(notReady());
    const poll = pollPairing({
      startedAt: pairingStartedAt(expiresAt, now),
      exchange,
      immediate: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(exchange).toHaveBeenCalledTimes(1);
    poll.stop();
    await expect(poll.done).resolves.toBe("stopped");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(exchange).toHaveBeenCalledTimes(1);
  });
});

describe("palette copy", () => {
  function block(): HTMLElement {
    document.body.innerHTML = `<code id="pair-command" tabindex="-1">/link 7F3K9Q</code>`;
    return document.getElementById("pair-command") as HTMLElement;
  }

  it("uses the Clipboard API in the popup and in a tab", async () => {
    const api = installChrome();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    for (const host of ["popup", "tab"] as const)
      await expect(copyText("/link 7F3K9Q", host, block())).resolves.toBe(
        "copied",
      );
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(api.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("asks the worker from a frame inside a page and never writes itself", async () => {
    const api = installChrome();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    api.runtime.sendMessage.mockResolvedValue(true);
    await expect(copyText("/link 7F3K9Q", "page", block())).resolves.toBe(
      "copied",
    );
    expect(api.runtime.sendMessage).toHaveBeenCalledWith({
      type: "copy-text",
      text: "/link 7F3K9Q",
    });
    expect(writeText).not.toHaveBeenCalled();
  });

  it("selects and focuses the /link text when the worker cannot copy", async () => {
    const api = installChrome();
    for (const answer of [
      () => api.runtime.sendMessage.mockResolvedValueOnce(false),
      () => api.runtime.sendMessage.mockResolvedValueOnce(undefined),
      () => api.runtime.sendMessage.mockRejectedValueOnce(new Error("gone")),
    ]) {
      answer();
      const element = block();
      await expect(copyText("/link 7F3K9Q", "page", element)).resolves.toBe(
        "selected",
      );
      expect(window.getSelection()?.toString()).toBe("/link 7F3K9Q");
      expect(document.activeElement).toBe(element);
    }
    expect(COPY_HINT_MAC).toBe("Press ⌘C to copy.");
  });

  it("falls back to the selection when the Clipboard API refuses", async () => {
    installChrome();
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("blur")) },
    });
    await expect(copyText("/link 7F3K9Q", "popup", block())).resolves.toBe(
      "selected",
    );
  });
});

describe("the worker's offscreen copy", () => {
  it("creates the offscreen document once and reuses it", async () => {
    vi.resetModules();
    const { copyThroughOffscreen: copy } =
      await import("../../src/offscreen-copy.js");
    const api = installChrome();
    api.runtime.sendMessage.mockResolvedValue(true);
    await expect(copy("/link A")).resolves.toBe(true);
    await expect(copy("/link B")).resolves.toBe(true);
    expect(api.offscreen.createDocument).toHaveBeenCalledTimes(1);
    expect(api.offscreen.createDocument).toHaveBeenCalledWith({
      url: "offscreen.html",
      reasons: ["CLIPBOARD"],
      justification: expect.any(String) as string,
    });
    expect(api.runtime.sendMessage).toHaveBeenLastCalledWith({
      target: "lens-offscreen",
      type: "copy",
      text: "/link B",
    });
  });

  it("reuses a document a restarted worker finds, and opens again after a failure", async () => {
    const api = installChrome();
    api.runtime.getContexts.mockResolvedValue([
      { contextType: "OFFSCREEN_DOCUMENT" },
    ]);
    api.runtime.sendMessage
      .mockRejectedValueOnce(new Error("Receiving end does not exist."))
      .mockResolvedValueOnce(true);
    await expect(copyThroughOffscreen("/link A")).resolves.toBe(false);
    api.runtime.getContexts.mockResolvedValue([]);
    await expect(copyThroughOffscreen("/link A")).resolves.toBe(true);
    expect(api.offscreen.createDocument).toHaveBeenCalledTimes(1);
  });
});
