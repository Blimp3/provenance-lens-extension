import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import type * as IntegrationClient from "../../src/integration-client.js";
import { palettePortName } from "../../src/palette-host.js";
import type * as Storage from "../../src/storage.js";

const mocks = vi.hoisted(() => ({
  createPairing: vi.fn(),
  exchangePairing: vi.fn(),
  getPendingPairing: vi.fn(),
  getSettings: vi.fn(),
  isIntegrationConnected: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock("../../src/cache.js", () => ({
  clearVerificationCache: vi.fn(),
  setCacheLimit: vi.fn(),
}));
vi.mock("../../src/storage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Storage>()),
  getActivity: () => Promise.resolve([]),
  getHistory: () => Promise.resolve([]),
  getSettings: mocks.getSettings,
  getWorkflowState: () => Promise.resolve(null),
  updateSettings: mocks.updateSettings,
}));
vi.mock("../../src/integration-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof IntegrationClient>()),
  createPairing: mocks.createPairing,
  exchangePairing: mocks.exchangePairing,
  getPendingPairing: mocks.getPendingPairing,
  isIntegrationConnected: mocks.isIntegrationConnected,
}));

/**
 * The palette frame itself, in jsdom: its own palette.html, a chrome stub
 * that logs every asynchronous call, and trusted input. jsdom cannot make a
 * trusted event, so a "trusted" key or click calls the frame's own listener
 * with an event whose isTrusted is true; a script's click() stays untrusted.
 */

const TOKEN = "0b6f5f3c-2a8e-4c61-9d5e-7a1c3e9b2f40";
const OPEN_KEY = "provenanceLens.paletteOpen";
const CLIENT_TOKEN = "typed-client-token-0123456789abcdef";
const BACKEND_URL = "https://backend.example";
const COVERED = "The page is covering Lens. Press Esc and open it again.";
const CREATING = "Creating a short-lived pairing request...";
const EXTENSION_ACCESS_URL =
  "chrome-extension://lens/settings.html#permissions-heading";
/** The Access rows the palette had before they moved to the Settings page. */
const REMOVED_ACCESS_ROWS = [
  "Optional access",
  "Allow one site…",
  "Granted sites",
] as const;

const html = await readFile(
  resolve(import.meta.dirname, "../../public/palette.html"),
  "utf8",
);
const body = new DOMParser().parseFromString(html, "text/html").body.innerHTML;
const top = Object.getOwnPropertyDescriptor(globalThis, "top");

type Listener = (...args: never[]) => unknown;
type Call = { name: string; args: unknown[] };

function event() {
  const listeners: Listener[] = [];
  return {
    listeners,
    addListener: (listener: Listener) => listeners.push(listener),
    removeListener: (listener: Listener) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
}

function chromeStub(record: Record<string, unknown>) {
  const calls: Call[] = [];
  const logged = (name: string, answer: (...args: unknown[]) => unknown) =>
    vi.fn((...args: unknown[]) => {
      calls.push({ name, args });
      return answer(...args);
    });
  const session = new Map<string, unknown>([[OPEN_KEY, record]]);
  const stub = {
    calls,
    granted: false,
    onConnect: event(),
  };
  const api = {
    runtime: {
      id: "lens",
      getURL: (path: string) => `chrome-extension://lens/${path}`,
      getManifest: () => ({ version: "2.1.0" }),
      sendMessage: logged("runtime.sendMessage", () => Promise.resolve(true)),
      onConnect: stub.onConnect,
    },
    storage: {
      session: {
        get: logged("storage.session.get", (key) =>
          Promise.resolve(
            session.has(key as string)
              ? { [key as string]: session.get(key as string) }
              : {},
          ),
        ),
        set: logged("storage.session.set", () => Promise.resolve()),
        remove: logged("storage.session.remove", (key) => {
          session.delete(key as string);
          return Promise.resolve();
        }),
      },
      local: {
        get: logged("storage.local.get", () => Promise.resolve({})),
        set: logged("storage.local.set", () => Promise.resolve()),
      },
      onChanged: event(),
    },
    permissions: {
      contains: logged("permissions.contains", () =>
        Promise.resolve(stub.granted),
      ),
      onAdded: event(),
      onRemoved: event(),
    },
    commands: {
      getAll: logged("commands.getAll", () =>
        Promise.resolve([{ name: "open-palette", shortcut: "⌥⇧Space" }]),
      ),
    },
    tabs: { create: logged("tabs.create", () => Promise.resolve({})) },
  };
  return Object.assign(stub, { api });
}

type Stub = ReturnType<typeof chromeStub>;

let added: MockInstance<EventTarget["addEventListener"]>;
let observed: ((entries: Array<{ isVisible: boolean }>) => void) | undefined;

class FakeIntersectionObserver {
  constructor(callback: (entries: Array<{ isVisible: boolean }>) => void) {
    observed = callback;
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  added = vi.spyOn(EventTarget.prototype, "addEventListener");
  observed = undefined;
  mocks.getSettings.mockResolvedValue({
    verificationMode: "website",
    acknowledgedVerificationModes: [],
    backendBaseUrl: BACKEND_URL,
    clientToken: CLIENT_TOKEN,
    historyRetention: 20,
    screenshotFallbackEnabled: false,
    includePageTitle: true,
    debugMode: false,
    localCacheLimit: 100,
    disclosureVersion: 1,
  });
  mocks.updateSettings.mockImplementation(async (changes: object) => ({
    ...(await (mocks.getSettings() as Promise<object>)),
    ...changes,
  }));
  // DigiBot never answers, so a pairing keeps waiting.
  mocks.exchangePairing.mockReturnValue(new Promise(() => undefined));
  mocks.getPendingPairing.mockResolvedValue(null);
  mocks.isIntegrationConnected.mockResolvedValue(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (top) Object.defineProperty(globalThis, "top", top);
  Reflect.deleteProperty(navigator, "clipboard");
});

/** Opens palette.html at a view, as the worker's single-use record says. */
async function openFrame(
  view: string,
  host: "tab" | "page" = "tab",
): Promise<Stub> {
  vi.resetModules();
  document.documentElement.className = "";
  document.body.innerHTML = body;
  history.replaceState(null, "", `/palette.html#t=${TOKEN}`);
  if (host === "page") {
    Object.defineProperty(globalThis, "top", {
      configurable: true,
      get: () => ({}),
    });
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  }
  const stub = chromeStub({
    token: TOKEN,
    tabId: 7,
    view,
    host,
    page: "web",
    hostname: "page.example",
    scope: "page",
    needsPick: false,
  });
  vi.stubGlobal("chrome", stub.api);
  await import("../../src/ui/palette.js");
  await vi.waitFor(() => expect(element("palette").hidden).toBe(false));
  return stub;
}

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} is missing.`);
  return found;
}

function listenersOf(target: EventTarget, type: string): Listener[] {
  return added.mock.calls.flatMap(([kind, listener], index) =>
    added.mock.contexts[index] === target &&
    kind === type &&
    typeof listener === "function"
      ? [listener as Listener]
      : [],
  );
}

function trusted(init: Record<string, unknown>): never {
  return {
    isTrusted: true,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 0,
    repeat: false,
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
    ...init,
  } as never;
}

function press(key: string, init: Record<string, unknown> = {}): void {
  for (const listener of listenersOf(document, "keydown"))
    listener(trusted({ key, code: key, ...init }));
}

function click(target: Element): void {
  for (const listener of listenersOf(target, "click"))
    listener(trusted({ target }));
}

const flush = () => new Promise<void>((done) => setTimeout(done, 0));

function rowTitle(index: number): string | null | undefined {
  return document.querySelector(`#row-${index} .row-title`)?.textContent;
}

function shown(selector: string): Array<string | null> {
  return [...document.querySelectorAll(selector)].map(
    ({ textContent }) => textContent,
  );
}

/** Types into the search field, as the input event the frame listens for. */
function type(value: string): void {
  const input = element("query") as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event("input"));
}

describe("the palette frame's Settings rows", () => {
  it("shows no Access row in Settings", async () => {
    await openFrame("settings");
    expect(shown(".group-header")).not.toContain("Access");
    for (const title of REMOVED_ACCESS_ROWS)
      expect(shown(".row-title")).not.toContain(title);
    expect(element("list").textContent).toContain(
      "Backend URL, client token, site access",
    );
  });

  it("finds no Access row in root search", async () => {
    await openFrame("root");
    for (const query of [
      "access",
      "optional access",
      "allow one site",
      "granted sites",
    ]) {
      type(query);
      for (const title of REMOVED_ACCESS_ROWS)
        expect(shown(".row-title")).not.toContain(title);
      expect(shown(".row-subtitle")).not.toContain("Settings › Access");
    }
  });

  it("opens Extension access on the Settings page from Finish setup", async () => {
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    const stub = await openFrame("root");
    expect(rowTitle(1)).toBe("Grant optional access");
    press("ArrowDown");
    press("Enter");
    // The palette closes once the tab is open.
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(stub.api.tabs.create).toHaveBeenCalledWith({
      url: EXTENSION_ACCESS_URL,
    });
  });

  it("opens Extension access on the Settings page from a command that needs download access", async () => {
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    const stub = await openFrame("root");
    type("synthid");
    expect(rowTitle(0)).toBe("Check with Google SynthID…");
    expect(element("row-0").textContent).toContain("Needs download access");
    press("Enter");
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(stub.api.tabs.create).toHaveBeenCalledWith({
      url: EXTENSION_ACCESS_URL,
    });
    expect(stub.api.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("shows a Clear notice until the next keystroke", async () => {
    await openFrame("settings");
    type("clear verification");
    expect(rowTitle(0)).toBe("Clear verification cache…");
    press("Enter");
    await vi.waitFor(() =>
      expect(element("chip").textContent).toBe(
        "Settings › Clear verification cache",
      ),
    );
    press("ArrowDown");
    press("Enter");
    await vi.waitFor(() =>
      expect(element("hint").textContent).toBe(
        "Local verification cache cleared.",
      ),
    );
    expect(element("chip").textContent).toBe("Settings");
    // The notice lasts until the next keystroke.
    type("d");
    expect(element("hint").textContent).not.toBe(
      "Local verification cache cleared.",
    );
  });

  it("runs a row only for a real click", async () => {
    await openFrame("settings");
    const row = element("row-0");
    row.click();
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(element("chip").textContent).toBe("Settings");
    click(row);
    await vi.waitFor(() =>
      expect(element("chip").textContent).toBe("Settings › DigiBot"),
    );
  });

  it("runs a ⌘K action only for a real click", async () => {
    await openFrame("settings");
    press("k", { code: "KeyK", ctrlKey: true });
    const action = element("action-0");
    expect(action.textContent).toContain("Run");
    action.click();
    await flush();
    expect(element("chip").textContent).toBe("Settings");
    expect(element("actions").hidden).toBe(false);
    click(action);
    await vi.waitFor(() =>
      expect(element("chip").textContent).toBe("Settings › DigiBot"),
    );
  });

  it("gives the search field focus back in each new view", async () => {
    await openFrame("settings");
    const input = element("query");
    input.blur();
    expect(document.activeElement).toBe(document.body);
    press("Enter");
    await vi.waitFor(() =>
      expect(element("chip").textContent).toBe("Settings › DigiBot"),
    );
    expect(document.activeElement).toBe(input);
  });

  it("turns a switch back for a second quick press", async () => {
    // Each save reads, waits and writes, as storage.ts does.
    let persisted = (await mocks.getSettings()) as {
      screenshotFallbackEnabled: boolean;
    };
    mocks.getSettings.mockImplementation(() =>
      Promise.resolve({ ...persisted }),
    );
    mocks.updateSettings.mockImplementation(async (changes: object) => {
      const current = { ...persisted };
      await flush();
      persisted = { ...current, ...changes };
      return persisted;
    });
    await openFrame("settings");
    for (let index = 0; index < 2; index += 1) press("ArrowDown");
    expect(rowTitle(2)).toBe("Screenshot copy fallback");
    press("Enter");
    press("Enter");
    await vi.waitFor(() =>
      expect(mocks.updateSettings).toHaveBeenCalledTimes(2),
    );
    await mocks.updateSettings.mock.results[1]?.value;
    await flush();
    expect(mocks.updateSettings.mock.calls).toEqual([
      [{ screenshotFallbackEnabled: true }],
      [{ screenshotFallbackEnabled: false }],
    ]);
    expect(persisted.screenshotFallbackEnabled).toBe(false);
    expect(element("row-2").textContent).toContain("Off");
  });

  it("never shows or sends the client token or the backend URL", async () => {
    const stub = await openFrame("settings");
    const shown = [document.body.innerHTML];
    for (let index = 0; index < 2; index += 1) press("ArrowDown");
    expect(rowTitle(2)).toBe("Screenshot copy fallback");
    press("Enter");
    await vi.waitFor(() =>
      expect(mocks.updateSettings).toHaveBeenCalledWith({
        screenshotFallbackEnabled: true,
      }),
    );
    shown.push(document.body.innerHTML);
    for (const text of [
      ...shown,
      JSON.stringify(stub.calls),
      JSON.stringify(mocks.updateSettings.mock.calls),
    ]) {
      expect(text).not.toContain(CLIENT_TOKEN);
      expect(text).not.toContain(BACKEND_URL);
    }
  });
});

describe("the palette frame's Connect view", () => {
  it("creates one pairing at a time and says what it is doing", async () => {
    await openFrame("connect");
    const writeText = vi.fn().mockRejectedValue(new Error("blur"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    let created: (pairing: object) => void = () => undefined;
    mocks.createPairing.mockReturnValue(
      new Promise((done) => {
        created = done;
      }),
    );
    expect(rowTitle(0)).toBe("Start pairing and copy /link");
    expect(element("live").textContent).toBe("DigiBot is not connected.");

    press("Enter");
    expect(element("live").textContent).toBe(CREATING);
    press("Enter");
    press("1", { code: "Digit1", altKey: true });
    expect(mocks.createPairing).toHaveBeenCalledTimes(1);

    created({
      pairId: "7F3K9Q",
      confirmationCode: "482913",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    // The copy fails, so the command is selected for a keyboard copy.
    await vi.waitFor(() =>
      expect(document.activeElement?.id).toBe("pair-command"),
    );
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(element("live").textContent).toBe(
      "Waiting for approval in Telegram…",
    );

    // Back to Settings: the selected command is gone, the search field
    // takes focus again.
    press("Escape");
    expect(element("chip").textContent).toBe("Settings");
    expect(document.activeElement).toBe(element("query"));
  });

  it("starts or resumes no pairing while a new one is created", async () => {
    mocks.getPendingPairing.mockResolvedValue({
      pairId: "OLD5W2",
      confirmationCode: "105274",
      expiresAt: new Date(Date.now() + 200_000).toISOString(),
    });
    let fail: (error: Error) => void = () => undefined;
    mocks.createPairing.mockReturnValue(
      new Promise((_, reject) => {
        fail = reject;
      }),
    );
    await openFrame("connect");
    expect([rowTitle(0), rowTitle(1), rowTitle(2)]).toEqual([
      "Complete DigiBot pairing",
      "Copy /link",
      "Start again",
    ]);

    press("3", { code: "Digit3", altKey: true });
    expect(element("live").textContent).toBe(CREATING);
    // The old pairing's rows stay on screen while the new one is created.
    expect(rowTitle(0)).toBe("Complete DigiBot pairing");
    press("1", { code: "Digit1", altKey: true });
    press("3", { code: "Digit3", altKey: true });
    await flush();
    expect(mocks.createPairing).toHaveBeenCalledTimes(1);
    expect(mocks.exchangePairing).not.toHaveBeenCalled();
    expect(element("live").textContent).toBe(CREATING);

    // Once the request fails, the old pairing can be completed again.
    fail(new Error("offline"));
    await vi.waitFor(() =>
      expect(element("live").textContent).toBe(
        "The DigiBot pairing request could not be created.",
      ),
    );
    press("1", { code: "Digit1", altKey: true });
    expect(mocks.exchangePairing).toHaveBeenCalledTimes(1);
  });

  it("keeps focus in the frame when the pairing ends", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await openFrame("connect");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("blur")) },
    });
    mocks.createPairing.mockResolvedValue({
      pairId: "7F3K9Q",
      confirmationCode: "482913",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    press("Enter");
    await vi.waitFor(() =>
      expect(document.activeElement?.id).toBe("pair-command"),
    );

    // DigiBot approves at the first check, 3 s in.
    mocks.exchangePairing.mockResolvedValue({});
    mocks.isIntegrationConnected.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() =>
      expect(element("live").textContent).toBe(
        "DigiBot is connected for this browser. Connected checks and downloads use that account.",
      ),
    );
    expect(document.getElementById("pair-command")).toBeNull();
    expect(document.activeElement).toBe(element("query"));
    expect(element("hint").hidden).toBe(true);
  });

  it("drops the copy hint when Complete DigiBot pairing replaces the /link", async () => {
    mocks.getPendingPairing.mockResolvedValue({
      pairId: "7F3K9Q",
      confirmationCode: "482913",
      expiresAt: new Date(Date.now() + 200_000).toISOString(),
    });
    await openFrame("connect");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("blur")) },
    });
    expect(rowTitle(1)).toBe("Copy /link");
    press("2", { code: "Digit2", altKey: true });
    await vi.waitFor(() =>
      expect(document.activeElement?.id).toBe("pair-command"),
    );
    expect(element("hint").hidden).toBe(false);

    press("1", { code: "Digit1", altKey: true });
    expect(element("live").textContent).toBe(
      "Waiting for approval in Telegram…",
    );
    expect(element("hint").hidden).toBe(true);
    expect(document.activeElement).toBe(element("query"));
  });
});

describe("the palette frame inside a page", () => {
  /** Answers the frame's host checks as a host that still stands. */
  function connectHost(stub: Stub): void {
    const answers = event();
    const port = {
      name: palettePortName(TOKEN),
      onMessage: answers,
      onDisconnect: event(),
      postMessage: (message: { lens: string; nonce: string }) => {
        if (message.lens !== "check") return;
        void Promise.resolve().then(() => {
          for (const answer of [...answers.listeners])
            (answer as (message: unknown) => void)({
              lens: "intact",
              nonce: message.nonce,
              intact: true,
            });
        });
      },
    };
    for (const listener of stub.onConnect.listeners)
      (listener as (port: unknown) => void)(port);
  }

  async function openInPage(view: string): Promise<Stub> {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
    });
    const stub = await openFrame(view, "page");
    connectHost(stub);
    return stub;
  }

  const ran: Record<string, (stub: Stub) => boolean> = {
    settings: () => element("chip").textContent === "Settings › DigiBot",
    connect: () => mocks.createPairing.mock.calls.length > 0,
    "verification-mode": () => mocks.updateSettings.mock.calls.length > 0,
  };

  it.each(Object.keys(ran))(
    "drops a key pressed before the panel shows, and its repeats, opened at %s",
    async (view) => {
      mocks.createPairing.mockReturnValue(new Promise(() => undefined));
      const stub = await openInPage(view);
      const check = ran[view] as (stub: Stub) => boolean;
      press("Enter");
      expect(element("status-text").textContent).toBe(COVERED);
      observed?.([{ isVisible: true }]);
      await vi.advanceTimersByTimeAsync(600);
      expect(check(stub)).toBe(false);

      // A key held from the page repeats once the panel shows: no repeat runs.
      press("Enter", { repeat: true });
      press("1", { code: "Digit1", altKey: true, repeat: true });
      await vi.advanceTimersByTimeAsync(10);
      expect(check(stub)).toBe(false);

      // The same key once the panel has been visible runs the first row.
      press("Enter");
      await vi.advanceTimersByTimeAsync(10);
      expect(check(stub)).toBe(true);
    },
  );

  it("keeps an early key for the first view until the panel shows", async () => {
    await openInPage("root");
    expect(rowTitle(0)).toBe("Connect DigiBot");
    press("Enter");
    expect(element("status-text").textContent).not.toBe(COVERED);
    observed?.([{ isVisible: true }]);
    await vi.advanceTimersByTimeAsync(300);
    expect(element("chip").textContent).toBe("Settings › DigiBot");
  });
});
