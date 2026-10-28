import {
  type ExtensionMessage,
  type ExtensionSettings,
  type HistoryRetention,
  type VerificationMode,
} from "@provenance-lens/shared";

import { clearVerificationCache, setCacheLimit } from "../cache.js";
import {
  disconnectIntegration,
  exchangePairing,
  getIntegrationSession,
  IntegrationClientError,
} from "../integration-client.js";
import {
  clearHistory,
  defaultSettings,
  getSettings,
  updateSettings,
} from "../storage.js";
import type { OptionalAccessState } from "./optional-access.js";
import {
  TAB_PAGE_URLS,
  type IconName,
  type PaletteView,
  type TabPage,
} from "./palette-commands.js";

/**
 * The palette's Settings table, its saves and the DigiBot pairing it runs.
 * The backend URL, the client token, the connection test and site access
 * stay on the Settings page ("Advanced settings ↗"). The palette reads the
 * whole stored settings record but keeps only its own six fields, so it
 * never shows, keeps or sends them.
 */

/** The settings the palette shows and changes. */
export type PaletteSettings = Pick<
  ExtensionSettings,
  | "verificationMode"
  | "screenshotFallbackEnabled"
  | "historyRetention"
  | "localCacheLimit"
  | "includePageTitle"
  | "debugMode"
>;
export type SettingKey = keyof PaletteSettings;
export type SettingUpdate = Partial<PaletteSettings>;

const SETTING_KEYS: readonly SettingKey[] = [
  "verificationMode",
  "screenshotFallbackEnabled",
  "historyRetention",
  "localCacheLimit",
  "includePageTitle",
  "debugMode",
];

/** Only the fields the palette shows: never the backend URL or the token. */
export function pickPaletteSettings(
  settings: ExtensionSettings,
): PaletteSettings {
  return {
    verificationMode: settings.verificationMode,
    screenshotFallbackEnabled: settings.screenshotFallbackEnabled,
    historyRetention: settings.historyRetention,
    localCacheLimit: settings.localCacheLimit,
    includePageTitle: settings.includePageTitle,
    debugMode: settings.debugMode,
  };
}

/** The latest save; each save waits for it, so a quick second one keeps both. */
let saving: Promise<unknown> = Promise.resolve();

/** Saves one change at once; a new cache limit also trims the cache. */
export function saveSetting(update: SettingUpdate): Promise<PaletteSettings> {
  return queued(() => saveNow(update));
}

/**
 * Turns a switch over from its stored value when its turn comes, so two
 * quick presses undo each other.
 */
export function flipSetting(key: SettingKey): Promise<PaletteSettings> {
  return queued(async () => {
    const value = (await getSettings())[key];
    if (typeof value !== "boolean")
      throw new TypeError(`${key} is not a switch.`);
    return saveNow({ [key]: !value });
  });
}

/** Runs after the save before it; a failed save does not block the next. */
function queued(
  save: () => Promise<PaletteSettings>,
): Promise<PaletteSettings> {
  const next = saving.then(save);
  saving = next.catch(() => undefined);
  return next;
}

async function saveNow(update: SettingUpdate): Promise<PaletteSettings> {
  const changes: SettingUpdate = {};
  for (const key of SETTING_KEYS)
    if (update[key] !== undefined)
      Object.assign(changes, { [key]: update[key] });
  const next = await updateSettings(changes);
  if (changes.localCacheLimit !== undefined)
    await setCacheLimit(next.localCacheLimit);
  return pickPaletteSettings(next);
}

/** ⌘K › Reset to default for one setting row. */
export function defaultFor(key: SettingKey): SettingUpdate {
  return { [key]: defaultSettings[key] };
}

// Text ----------------------------------------------------------------------

/** Card 3 of the Settings page, word for word; a unit test compares them. */
export const CONNECT_INTRO =
  "Link this browser to your private DigiBot account to send selected originals, keep shared History, and view account statistics.";
export const CONNECT_CONSENT =
  "Check sends the selected file to OpenAI for supported provenance signals; these checks are not eligible for Zero Data Retention. Checked images are also saved as exact files in Telegram. Temporary processing copies expire after 24 hours. Download only sends the selected file to Telegram and does not run a check. Send this page's link to Telegram sends the full page address, including any query parameters such as signed or private-link tokens, only to the connected DigiBot, where it is kept encrypted with the job; the fragment after # is not sent. DigiBot downloads the video itself and posts it in your Telegram chat as a video, a voice note, an audio file or a clip. Pick a video on this page sends the link of a post or video you click instead of the page address. Verify audio of this page and Clip › Verify this clip's audio send the active tab's full address to DigiBot, which sends an excerpt of at most 60 seconds of its audio to OpenAI. Provider processing details. Shared History remains until you delete it; local History settings below apply only to standalone results.";
export const PROVIDER_DETAILS_URL =
  "https://developers.openai.com/api/docs/guides/content-provenance";
export const PAIR_INSTRUCTION =
  "In your private DigiBot chat, send this command and approve the matching code.";

/** Today's Settings page strings for the DigiBot connection. */
export const PAIRING_TEXT = {
  creating: "Creating a short-lived pairing request...",
  createFailed: "The DigiBot pairing request could not be created.",
  ready:
    "Pairing request ready. Approve the matching code in your private DigiBot chat.",
  waiting: "Waiting for approval in Telegram…",
  connected:
    "DigiBot is connected for this browser. Connected checks and downloads use that account.",
  notConnected: "DigiBot is not connected.",
  timeout:
    "The pairing was not approved yet or has expired. Start again after approving it in DigiBot.",
  disconnecting: "Disconnecting DigiBot...",
  disconnectFailed: "The DigiBot connection could not be cleared.",
} as const;

/** The two disclosure lines of the Settings page's Verification mode card. */
export const MODE_DISCLOSURES = [
  "Website mode downloads the exact selected image file and opens OpenAI Verify for you to upload and review manually. Lens never automates, submits to, or scrapes that website.",
  "API mode sends the exact selected image or audio file to your configured verification backend for an automatic result. The backend and a valid OpenAI API key are required; the API key stays on the backend and is never stored in this extension.",
] as const;

/** "What a result means", from the README's verdict table and the details page. */
export const RESULT_MEANINGS = [
  "Website mode leaves interpretation on OpenAI Verify. When API mode returns a result to Lens, the OpenAI part of the result uses three normalized verdicts.",
  "OpenAI provenance detected: one or more supported C2PA or SynthID results reported detected. The details identify C2PA, SynthID, or both.",
  "No supported OpenAI signal detected: no supported OpenAI provenance signal was detected. This does not prove that the image is human-made or that it was not generated by another AI system.",
  "The image could not be verified: Lens gives a short reason, such as an inaccessible image, invalid input, missing configuration, an unavailable API, or an invalid API response.",
  "A valid signature binds a signed history to this exact file; it does not prove that the depicted scene is true. Credentials may be absent or removed, and AI systems may leave no supported signal. A missing audio signal does not prove that audio is human-recorded.",
] as const;

export const COPY_HINT_MAC = "Press ⌘C to copy.";
export const COPY_HINT_OTHER = "Press Ctrl+C to copy.";

// The Settings table ---------------------------------------------------------

type SettingsGroup =
  | "DigiBot"
  | "Verification"
  | "History and privacy"
  | "Keys"
  | "About"
  | "More";

export type SettingsRun =
  | { kind: "view"; view: PaletteView }
  | { kind: "toggle"; setting: SettingKey }
  | { kind: "tab"; page: TabPage }
  | { kind: "none" };

export type SettingsItem = {
  id: string;
  group: SettingsGroup;
  title: string;
  /** Its own subtitle; search shows "Settings › {group}" when it has none. */
  subtitle?: string;
  icon: IconName;
  value?: string;
  keys?: readonly string[];
  run: SettingsRun;
  /** The value ⌘K › Reset to default restores. */
  setting?: SettingKey;
};

export type SettingsState = {
  settings: PaletteSettings;
  connected: boolean;
  /** The palette key as the browser shows it; "" when none is set. */
  paletteShortcut: readonly string[];
  version: string;
};

const MODE_VALUES: Readonly<Record<VerificationMode, string>> = {
  website: "Website review",
  api: "Automatic API",
};

function onOff(value: boolean): string {
  return value ? "On" : "Off";
}

function retentionText(retention: HistoryRetention): string {
  return retention === 0 ? "Off" : `Last ${retention}`;
}

function cacheText(limit: number): string {
  return limit.toLocaleString("en-US");
}

/** Every row of the Settings view, in order; each is also a search result. */
export function settingsItems(state: SettingsState): SettingsItem[] {
  const { settings } = state;
  return [
    {
      id: "setting-digibot",
      group: "DigiBot",
      title: "DigiBot",
      icon: "plug",
      value: state.connected ? "Connected" : "Not connected",
      run: { kind: "view", view: "connect" },
    },
    {
      id: "setting-verification-mode",
      group: "Verification",
      title: "Verification mode",
      icon: "shield-check",
      value: MODE_VALUES[settings.verificationMode],
      run: { kind: "view", view: "verification-mode" },
      setting: "verificationMode",
    },
    {
      id: "setting-screenshot-fallback",
      group: "Verification",
      title: "Screenshot copy fallback",
      icon: "image",
      value: onOff(settings.screenshotFallbackEnabled),
      run: { kind: "toggle", setting: "screenshotFallbackEnabled" },
      setting: "screenshotFallbackEnabled",
    },
    {
      id: "setting-keep-history",
      group: "History and privacy",
      title: "Keep history",
      icon: "clock",
      value: retentionText(settings.historyRetention),
      run: { kind: "view", view: "history-retention" },
      setting: "historyRetention",
    },
    {
      id: "setting-local-cache",
      group: "History and privacy",
      title: "Local cache",
      icon: "sliders",
      value: cacheText(settings.localCacheLimit),
      run: { kind: "view", view: "cache-limit" },
      setting: "localCacheLimit",
    },
    {
      id: "setting-page-title",
      group: "History and privacy",
      title: "Save page title",
      icon: "sliders",
      value: onOff(settings.includePageTitle),
      run: { kind: "toggle", setting: "includePageTitle" },
      setting: "includePageTitle",
    },
    {
      id: "setting-debug",
      group: "History and privacy",
      title: "Debug details",
      icon: "info",
      value: onOff(settings.debugMode),
      run: { kind: "toggle", setting: "debugMode" },
      setting: "debugMode",
    },
    {
      id: "setting-clear-history",
      group: "History and privacy",
      title: "Clear history…",
      icon: "x",
      run: { kind: "view", view: "clear-history" },
    },
    {
      id: "setting-clear-cache",
      group: "History and privacy",
      title: "Clear verification cache…",
      icon: "x",
      run: { kind: "view", view: "clear-cache" },
    },
    {
      id: "setting-palette-shortcut",
      group: "Keys",
      title: "Palette shortcut",
      icon: "keyboard",
      ...(state.paletteShortcut.length > 0
        ? { keys: state.paletteShortcut }
        : { value: "Not set" }),
      run: { kind: "tab", page: "shortcuts" },
    },
    {
      id: "setting-command-hotkeys",
      group: "Keys",
      title: "Command hotkeys",
      icon: "keyboard",
      run: { kind: "view", view: "command-hotkeys" },
    },
    {
      id: "setting-aliases",
      group: "Keys",
      title: "Aliases",
      icon: "key",
      run: { kind: "view", view: "aliases" },
    },
    {
      id: "setting-version",
      group: "About",
      title: "Version",
      subtitle: "Lens never scans pages.",
      icon: "info",
      value: state.version,
      run: { kind: "none" },
    },
    {
      id: "setting-result-meaning",
      group: "About",
      title: "What a result means",
      icon: "shield-check",
      run: { kind: "view", view: "about-results" },
    },
    {
      id: "setting-advanced",
      group: "More",
      title: "Advanced settings",
      subtitle: "Backend URL, client token, site access",
      icon: "sliders",
      run: { kind: "tab", page: "advanced" },
    },
  ];
}

export type FinishSetupState = {
  connected: boolean;
  pairingPending: boolean;
  optionalAccess: OptionalAccessState | null;
  /** The palette key as the browser shows it; "" when another holds it. */
  paletteShortcut: string | undefined;
};

type FinishSetupItem = {
  id: "connect" | "complete-pairing" | "optional-access" | "palette-shortcut";
  title: string;
  subtitle: string;
};

/** The root's Finish setup rows: only the items still missing. */
export function finishSetupItems(state: FinishSetupState): FinishSetupItem[] {
  const items: FinishSetupItem[] = [];
  if (!state.connected)
    items.push(
      state.pairingPending
        ? {
            id: "complete-pairing",
            title: "Complete DigiBot pairing",
            subtitle: "Waiting for your approval",
          }
        : {
            id: "connect",
            title: "Connect DigiBot",
            subtitle: "Needed for Download and Clip",
          },
    );
  if (state.optionalAccess !== null && !state.optionalAccess.complete)
    items.push({
      id: "optional-access",
      title: "Grant optional access",
      subtitle: "Read images on any site, save exact files",
    });
  if (state.paletteShortcut === "")
    items.push({
      id: "palette-shortcut",
      title: "Choose a palette shortcut",
      subtitle: "⌥⇧Space is taken",
    });
  return items;
}

// Choice and Confirm views ----------------------------------------------------

export type ChoiceView =
  "verification-mode" | "history-retention" | "cache-limit";

export type Choice = { title: string; update: SettingUpdate; current: boolean };

export function choicesFor(
  view: ChoiceView,
  settings: PaletteSettings,
): Choice[] {
  switch (view) {
    case "verification-mode":
      return (
        [
          ["website", "Website review (manual)"],
          ["api", "Automatic API result"],
        ] as const
      ).map(([mode, title]) => ({
        title,
        update: { verificationMode: mode },
        current: settings.verificationMode === mode,
      }));
    case "history-retention":
      return ([0, 10, 20, 50] as const).map((retention) => ({
        title: retentionText(retention),
        update: { historyRetention: retention },
        current: settings.historyRetention === retention,
      }));
    case "cache-limit":
      return [10, 50, 100, 250, 1_000].map((limit) => ({
        title: `${cacheText(limit)} results`,
        update: { localCacheLimit: limit },
        current: settings.localCacheLimit === limit,
      }));
  }
}

export type ConfirmView =
  "disconnect" | "clear-history" | "clear-cache" | "reset-aliases";

type ConfirmChoice = { title: string; danger: boolean };

/** The message row and the two choices: Cancel first, then the danger action. */
export function confirmFor(
  view: ConfirmView,
  savedResults: number,
): { message: string; choices: [ConfirmChoice, ConfirmChoice] } {
  const [message, action] = (
    {
      disconnect: [
        "Disconnect DigiBot from this browser?",
        "Disconnect DigiBot",
      ],
      "clear-history": [
        `Clear ${savedResults} saved ${savedResults === 1 ? "result" : "results"}? This cannot be undone.`,
        "Clear history",
      ],
      "clear-cache": [
        "Clear the local verification cache? This cannot be undone.",
        "Clear cache",
      ],
      "reset-aliases": ["Reset every alias to its default?", "Reset aliases"],
    } as const
  )[view];
  return {
    message,
    choices: [
      { title: "Cancel", danger: false },
      { title: action, danger: true },
    ],
  };
}

// Actions --------------------------------------------------------------------

export type Outcome = { ok: boolean; message: string };

export async function clearSavedHistory(): Promise<Outcome> {
  await clearHistory();
  const connected = await getIntegrationSession().catch(() => null);
  return {
    ok: true,
    message: connected
      ? "Local standalone history cleared. Manage connected History from the History page."
      : "History cleared.",
  };
}

export async function clearSavedCache(): Promise<Outcome> {
  await clearVerificationCache();
  return { ok: true, message: "Local verification cache cleared." };
}

export async function disconnectDigiBot(): Promise<Outcome> {
  try {
    await disconnectIntegration();
    return { ok: true, message: PAIRING_TEXT.notConnected };
  } catch {
    return { ok: false, message: PAIRING_TEXT.disconnectFailed };
  }
}

export async function openTabPage(page: TabPage): Promise<void> {
  const target = TAB_PAGE_URLS[page];
  await chrome.tabs.create({
    url: target.startsWith("chrome://")
      ? target
      : chrome.runtime.getURL(target),
  });
}

// Pairing --------------------------------------------------------------------

/** A pairing is polled for at most 5 minutes, DigiBot's pairing lifetime. */
export const PAIRING_LIMIT_MS = 5 * 60_000;
const PAIRING_FAST_MS = 3_000;
const PAIRING_FAST_FOR_MS = 30_000;
const PAIRING_SLOW_MS = 30_000;

/**
 * Every 3 s for the first 30 s, then every 30 s: at most 19 exchanges for a
 * pairing, under DigiBot's 20 exchange requests per address in 10 minutes.
 */
function pairingPollDelay(elapsedMs: number): number {
  return elapsedMs < PAIRING_FAST_FOR_MS ? PAIRING_FAST_MS : PAIRING_SLOW_MS;
}

/** When a stored pairing began, from its expiry. */
export function pairingStartedAt(expiresAt: string, now = Date.now()): number {
  const started = Date.parse(expiresAt) - PAIRING_LIMIT_MS;
  return Number.isFinite(started)
    ? Math.min(now, Math.max(now - PAIRING_LIMIT_MS, started))
    : now;
}

type PairingOutcome = "connected" | "timeout" | "stopped";
export type PairingPoll = { stop: () => void; done: Promise<PairingOutcome> };

/**
 * Asks DigiBot whether the pending pairing was approved until it is, until
 * the pairing has run for 5 minutes or is gone, or until stop(). Only Start
 * pairing and Complete DigiBot pairing start a poll.
 */
export function pollPairing(options: {
  startedAt: number;
  /** Check at once: the user asked to complete a pairing again. */
  immediate?: boolean;
  exchange?: () => Promise<unknown>;
}): PairingPoll {
  const exchange = options.exchange ?? exchangePairing;
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finish: (outcome: PairingOutcome) => void = () => undefined;
  const done = new Promise<PairingOutcome>((resolve) => {
    finish = resolve;
  });
  const end = (outcome: PairingOutcome): void => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    finish(outcome);
  };
  const elapsed = (): number => Date.now() - options.startedAt;
  const check = async (): Promise<void> => {
    if (ended) return;
    if (elapsed() >= PAIRING_LIMIT_MS) {
      end("timeout");
      return;
    }
    try {
      await exchange();
      end("connected");
      return;
    } catch (error: unknown) {
      if (
        error instanceof IntegrationClientError &&
        error.code === "pairing_expired"
      ) {
        end("timeout");
        return;
      }
      // Not approved yet, rate-limited or unreachable: ask again later.
    }
    schedule();
  };
  const schedule = (): void => {
    if (ended) return;
    const spent = elapsed();
    timer = setTimeout(
      () => void check(),
      Math.max(0, Math.min(pairingPollDelay(spent), PAIRING_LIMIT_MS - spent)),
    );
  };
  if (options.immediate) void check();
  else schedule();
  return { stop: () => end("stopped"), done };
}

/** "482913" as "482 913". */
export function formatPairingCode(code: string): string {
  return code.replace(/^(\d{3})(\d{3})$/u, "$1 $2");
}

// Copy -----------------------------------------------------------------------

type CopyHost = "page" | "popup" | "tab";
type CopyResult = "copied" | "selected";

/**
 * Copies text in a fixed order. The fallback popup and a tab are extension
 * pages, so the Clipboard API works there. A frame inside a page never
 * writes to the clipboard itself: the page's Permissions Policy can block
 * it, so the worker copies through its offscreen document. When that fails
 * too, the visible text is selected and focused for a keyboard copy, which
 * no page policy blocks.
 */
export async function copyText(
  text: string,
  host: CopyHost,
  visible: HTMLElement | null,
): Promise<CopyResult> {
  if (await writeClipboard(text, host)) return "copied";
  if (visible) selectText(visible);
  return "selected";
}

async function writeClipboard(text: string, host: CopyHost): Promise<boolean> {
  try {
    if (host !== "page") {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const message: ExtensionMessage = { type: "copy-text", text };
    return (await chrome.runtime.sendMessage(message)) === true;
  } catch {
    return false;
  }
}

function selectText(element: HTMLElement): void {
  element.focus();
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}
