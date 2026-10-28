import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as IntegrationClient from "../../src/integration-client.js";
import type * as Storage from "../../src/storage.js";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  setCacheLimit: vi.fn(),
  clearVerificationCache: vi.fn(),
  clearHistory: vi.fn(),
  exchangePairing: vi.fn(),
  getIntegrationSession: vi.fn(),
}));

vi.mock("../../src/cache.js", () => ({
  clearVerificationCache: mocks.clearVerificationCache,
  setCacheLimit: mocks.setCacheLimit,
}));
// The real defaults, which the Settings table is checked against.
vi.mock("../../src/storage.js", async (importOriginal) => ({
  clearHistory: mocks.clearHistory,
  defaultSettings: (await importOriginal<typeof Storage>()).defaultSettings,
  getSettings: mocks.getSettings,
  updateSettings: mocks.updateSettings,
}));
vi.mock("../../src/integration-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof IntegrationClient>()),
  exchangePairing: mocks.exchangePairing,
  getIntegrationSession: mocks.getIntegrationSession,
}));

import { IntegrationClientError } from "../../src/integration-client.js";
import { copyThroughOffscreen } from "../../src/offscreen-copy.js";
import { defaultSettings } from "../../src/storage.js";
import { checkAlias, effectiveAliases } from "../../src/ui/palette-commands.js";
import {
  choicesFor,
  clearSavedCache,
  clearSavedHistory,
  confirmFor,
  COPY_HINT_MAC,
  copyText,
  defaultFor,
  finishSetupItems,
  flipSetting,
  openTabPage,
  PAIRING_LIMIT_MS,
  pairingStartedAt,
  pickPaletteSettings,
  pollPairing,
  saveSetting,
  settingsItems,
  type ChoiceView,
  type ConfirmView,
  type SettingKey,
  type SettingsRun,
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
  mocks.getIntegrationSession.mockResolvedValue(null);
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

  it("runs two quick saves one after the other, so both persist", async () => {
    installChrome();
    // Each save reads, waits and writes, as storage.ts does.
    let persisted = { ...stored };
    mocks.updateSettings.mockImplementation(async (changes: object) => {
      const current = { ...persisted };
      await new Promise((resolve) => setTimeout(resolve, 0));
      persisted = { ...current, ...changes };
      return persisted;
    });
    const [first, second] = await Promise.all([
      saveSetting({ includePageTitle: false }),
      saveSetting({ debugMode: true }),
    ]);
    expect(persisted).toMatchObject({
      includePageTitle: false,
      debugMode: true,
    });
    expect(first.includePageTitle).toBe(false);
    expect(second).toMatchObject({ includePageTitle: false, debugMode: true });
    // A failed save does not stop the next one.
    mocks.updateSettings.mockRejectedValueOnce(new Error("quota"));
    await expect(saveSetting({ debugMode: false })).rejects.toThrow("quota");
    await expect(saveSetting({ historyRetention: 50 })).resolves.toMatchObject({
      historyRetention: 50,
    });
  });

  it("turns a switch over from its stored value, so two quick presses undo each other", async () => {
    installChrome();
    let persisted = { ...stored };
    mocks.getSettings.mockImplementation(() =>
      Promise.resolve({ ...persisted }),
    );
    mocks.updateSettings.mockImplementation(async (changes: object) => {
      const current = { ...persisted };
      await new Promise((resolve) => setTimeout(resolve, 0));
      persisted = { ...current, ...changes };
      return persisted;
    });
    const [first, second] = await Promise.all([
      flipSetting("debugMode"),
      flipSetting("debugMode"),
    ]);
    expect(first.debugMode).toBe(true);
    expect(second.debugMode).toBe(false);
    expect(persisted.debugMode).toBe(false);
    await expect(flipSetting("historyRetention")).rejects.toThrow(
      "historyRetention is not a switch.",
    );
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

  it("names no backend field in the palette's own code", async () => {
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
      subtitle: "Backend URL, client token, site access",
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
      "Keys",
      "About",
      "More",
    ]);
    expect(
      settingsItems(state()).find(({ title }) => title === "Version"),
    ).toMatchObject({ value: "2.1.0", subtitle: "Lens never scans pages." });
  });

  // Since L4 the palette is the only place for these settings: the Settings
  // page keeps only the API connection and Extension access.
  it("lists every setting with the stored defaults row by row", () => {
    const defaults = pickPaletteSettings(defaultSettings);
    const run = ({ run: target }: { run: SettingsRun }): string =>
      target.kind === "view"
        ? `view ${target.view}`
        : target.kind === "toggle"
          ? `toggle ${target.setting}`
          : target.kind === "tab"
            ? `tab ${target.page}`
            : target.kind;
    // Group, title, what it runs, the field ⌘K resets, its value at defaults.
    expect(
      settingsItems(state({ settings: defaults })).map((item) => [
        item.group,
        item.title,
        run(item),
        item.setting ?? null,
        item.value ?? null,
      ]),
    ).toEqual([
      ["DigiBot", "DigiBot", "view connect", null, "Not connected"],
      [
        "Verification",
        "Verification mode",
        "view verification-mode",
        "verificationMode",
        "Website review",
      ],
      [
        "Verification",
        "Screenshot copy fallback",
        "toggle screenshotFallbackEnabled",
        "screenshotFallbackEnabled",
        "Off",
      ],
      [
        "History and privacy",
        "Keep history",
        "view history-retention",
        "historyRetention",
        "Last 20",
      ],
      [
        "History and privacy",
        "Local cache",
        "view cache-limit",
        "localCacheLimit",
        "100",
      ],
      [
        "History and privacy",
        "Save page title",
        "toggle includePageTitle",
        "includePageTitle",
        "On",
      ],
      [
        "History and privacy",
        "Debug details",
        "toggle debugMode",
        "debugMode",
        "Off",
      ],
      [
        "History and privacy",
        "Clear history…",
        "view clear-history",
        null,
        null,
      ],
      [
        "History and privacy",
        "Clear verification cache…",
        "view clear-cache",
        null,
        null,
      ],
      ["Keys", "Palette shortcut", "tab shortcuts", null, null],
      ["Keys", "Command hotkeys", "view command-hotkeys", null, null],
      ["Keys", "Aliases", "view aliases", null, null],
      ["About", "Version", "none", null, "2.1.0"],
      ["About", "What a result means", "view about-results", null, null],
      ["More", "Advanced settings", "tab advanced", null, null],
    ]);

    const choices = (view: ChoiceView) =>
      choicesFor(view, defaults).map(({ title, update, current }) => [
        title,
        String(Object.values(update)[0]),
        current,
      ]);
    expect(choices("verification-mode")).toEqual([
      ["Website review (manual)", "website", true],
      ["Automatic API result", "api", false],
    ]);
    expect(choices("history-retention")).toEqual([
      ["Off", "0", false],
      ["Last 10", "10", false],
      ["Last 20", "20", true],
      ["Last 50", "50", false],
    ]);
    expect(choices("cache-limit")).toEqual([
      ["10 results", "10", false],
      ["50 results", "50", false],
      ["100 results", "100", true],
      ["250 results", "250", false],
      ["1,000 results", "1000", false],
    ]);
    // ⌘K › Reset to default restores storage.ts's own default.
    for (const key of [
      "verificationMode",
      "screenshotFallbackEnabled",
      "historyRetention",
      "localCacheLimit",
      "includePageTitle",
      "debugMode",
    ] satisfies SettingKey[])
      expect(defaultFor(key)).toEqual({ [key]: defaultSettings[key] });
  });
});

describe("palette settings without site access", () => {
  it("opens Extension access on the Settings page and never asks the browser itself", async () => {
    const api = installChrome();
    await openTabPage("access");
    expect(api.tabs.create).toHaveBeenCalledWith({
      url: "chrome-extension://test/settings.html#permissions-heading",
    });
    for (const file of ["src/ui/palette.ts", "src/ui/palette-settings.ts"]) {
      const source = await readFile(
        resolve(import.meta.dirname, "../..", file),
        "utf8",
      );
      expect(source).not.toMatch(
        /permissions\.request|requestFullOptionalAccess|permissions\.getAll/u,
      );
    }
  });
});

describe("palette settings validation", () => {
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
});

describe("palette Clear history and Clear verification cache", () => {
  it("clears and says what was cleared", async () => {
    mocks.clearHistory.mockResolvedValue(undefined);
    mocks.clearVerificationCache.mockResolvedValue(undefined);
    await expect(clearSavedHistory()).resolves.toEqual({
      ok: true,
      message: "History cleared.",
    });
    mocks.getIntegrationSession.mockResolvedValueOnce({ accountId: "a" });
    await expect(clearSavedHistory()).resolves.toEqual({
      ok: true,
      message:
        "Local standalone history cleared. Manage connected History from the History page.",
    });
    expect(mocks.clearHistory).toHaveBeenCalledTimes(2);
    await expect(clearSavedCache()).resolves.toEqual({
      ok: true,
      message: "Local verification cache cleared.",
    });
    expect(mocks.clearVerificationCache).toHaveBeenCalledTimes(1);
    // A failure reaches the palette, which reports it.
    mocks.clearHistory.mockRejectedValueOnce(new Error("busy"));
    await expect(clearSavedHistory()).rejects.toThrow("busy");
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
