import {
  ACTION_ID,
  AUDIO_ACTION_ID,
  DOWNLOAD_ACTION_ID,
  LINK_ACTION_ID,
  PICK_VIDEO_ACTION_ID,
  SYNTHID_ACTION_ID,
  type ActionId,
  type LinkDownloadOptions,
} from "@provenance-lens/shared";

import { parseClockRange, type ClipRangeResult } from "./link-output.js";

/**
 * The Lens palette's commands, views, ranking, aliases and keys. Everything
 * here is pure, so the worker routes its browser commands through the same
 * table the frame shows.
 */

/** The session record the worker writes before it mounts a palette. */
export const PALETTE_OPEN_KEY = "provenanceLens.paletteOpen";
/** Aliases and Last used, apart from ExtensionSettings. */
export const PALETTE_PREFS_KEY = "provenanceLens.palette";
/**
 * The workflow message of the download pick for an image or a video; the
 * DOWNLOAD action's image-only pick from the context menu has its own.
 */
export const MEDIA_PICK_MESSAGE =
  "Click an image or a video to send it to Telegram.";

/** The browser commands in the manifest, in its order. */
export const DECLARED_COMMAND_IDS = [
  "open-palette",
  "pick-image",
  "send-page-video",
  "send-page-audio",
  "send-page-audio-file",
  "pick-media-telegram",
  "pick-post-audio",
  "pick-post-audio-file",
  "cancel-active",
  "open-clip",
] as const;
export type DeclaredCommandId = (typeof DECLARED_COMMAND_IDS)[number];

/** Views the worker opens the palette at. */
export type OpenView =
  | "root"
  | "download"
  | "clip"
  | "recent"
  | "settings"
  | "connect"
  | "access"
  | "verification-mode";
/** The views under Settings, which open with Settings one step back. */
type SettingsView =
  | "connect"
  | "disconnect"
  | "verification-mode"
  | "history-retention"
  | "cache-limit"
  | "clear-history"
  | "clear-cache"
  | "access"
  | "allow-site"
  | "granted-sites"
  | "command-hotkeys"
  | "aliases"
  | "reset-aliases"
  | "about-results";
export type PaletteView =
  OpenView | SettingsView | "verify" | "audio-range" | "alias";

type StartRoute = {
  kind: "start";
  actionId: ActionId;
  options?: LinkDownloadOptions;
};
export type CommandRoute =
  { kind: "palette"; view: OpenView } | StartRoute | { kind: "cancel" };

/** What each browser command does when its key is pressed. */
export const COMMAND_ROUTES: Readonly<Record<DeclaredCommandId, CommandRoute>> =
  {
    "open-palette": { kind: "palette", view: "root" },
    "pick-image": { kind: "start", actionId: ACTION_ID },
    "send-page-video": { kind: "start", actionId: LINK_ACTION_ID },
    "send-page-audio": {
      kind: "start",
      actionId: LINK_ACTION_ID,
      options: { output: "voice" },
    },
    "send-page-audio-file": {
      kind: "start",
      actionId: LINK_ACTION_ID,
      options: { output: "m4a" },
    },
    "pick-media-telegram": { kind: "start", actionId: DOWNLOAD_ACTION_ID },
    "pick-post-audio": {
      kind: "start",
      actionId: PICK_VIDEO_ACTION_ID,
      options: { output: "voice" },
    },
    "pick-post-audio-file": {
      kind: "start",
      actionId: PICK_VIDEO_ACTION_ID,
      options: { output: "m4a" },
    },
    "cancel-active": { kind: "cancel" },
    "open-clip": { kind: "palette", view: "clip" },
  };

export function commandRoute(command: string): CommandRoute | null {
  return (DECLARED_COMMAND_IDS as readonly string[]).includes(command)
    ? COMMAND_ROUTES[command as DeclaredCommandId]
    : null;
}

/**
 * What the palette knows about the page it opened on: only its host name and
 * what may run there, never its address.
 */
export type PaletteOpenRecord = {
  token: string;
  tabId: number;
  view: OpenView;
  host: "page" | "popup" | "tab";
  /** "web": a normal page; "link-only": an http(s) tab no script may enter. */
  page: "web" | "link-only" | "none";
  hostname: string;
  /** "video": opened from a right-clicked video. */
  scope: "page" | "video";
  /** An X or YouTube listing page, such as a timeline, channel or search. */
  needsPick: boolean;
};

const OPEN_VIEWS: readonly string[] = [
  "root",
  "download",
  "clip",
  "recent",
  "settings",
  "connect",
  "access",
  "verification-mode",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function parsePaletteOpenRecord(
  value: unknown,
): PaletteOpenRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const { token, tabId, view, host, page, hostname, scope, needsPick } = record;
  if (
    typeof token !== "string" ||
    !UUID.test(token) ||
    typeof tabId !== "number" ||
    !Number.isSafeInteger(tabId) ||
    tabId < 0 ||
    typeof view !== "string" ||
    !OPEN_VIEWS.includes(view) ||
    (host !== "page" && host !== "popup" && host !== "tab") ||
    (page !== "web" && page !== "link-only" && page !== "none") ||
    typeof hostname !== "string" ||
    hostname.length > 255 ||
    (scope !== "page" && scope !== "video") ||
    typeof needsPick !== "boolean"
  )
    return null;
  return {
    token,
    tabId,
    view: view as OpenView,
    host,
    page,
    hostname,
    scope,
    needsPick,
  };
}

export type IconName =
  | "download"
  | "shield-check"
  | "scissors"
  | "clock"
  | "sliders"
  | "film"
  | "mic"
  | "music"
  | "waveform"
  | "image"
  | "link"
  | "key"
  | "keyboard"
  | "plug"
  | "chevron-right"
  | "external"
  | "check"
  | "info"
  | "alert-triangle"
  | "x"
  | "lock"
  | "copy";

/**
 * Pages a row opens in a tab. "advanced" is the Settings page, which keeps
 * the backend settings the palette never shows.
 */
export type TabPage = "advanced" | "history" | "shortcuts";

export const TAB_PAGE_URLS: Readonly<Record<TabPage, string>> = {
  advanced: "settings.html",
  history: "history.html",
  shortcuts: "chrome://extensions/shortcuts",
};

export type CommandRun =
  | { kind: "view"; view: PaletteView }
  | (StartRoute & { range?: boolean })
  | { kind: "cancel" }
  | { kind: "tab"; page: TabPage };

/**
 * What a command needs before it can run: DigiBot, a page Lens can enter, an
 * http(s) tab, download access, or a valid range.
 */
type Need = "digibot" | "page" | "link" | "downloads" | "range";

export type PaletteCommand = {
  id: string;
  title: string;
  subtitle: string;
  icon: IconName;
  run: CommandRun;
  /** The default alias. */
  alias?: string;
  needs?: readonly Need[];
  /** Where it lives, as Last used and search results show it. */
  path: string;
  /** Last used may hold it. */
  leaf?: boolean;
  /** The footer's verb for ↵. */
  verb: "Open" | "Run" | "Send";
  /** The note under the row, word for word. */
  note?: string;
  /** It opens a new tab or Google's site, so the row shows "↗". */
  external?: boolean;
};

/** The note under the SynthID row. */
export const SYNTHID_ROW_NOTE =
  "Google has no SynthID API yet, so Lens opens Google's SynthID Detector with your file. Lens will check it directly once Google releases an API.";

const command = (entry: PaletteCommand): PaletteCommand => entry;

/** Every command row, in table order; ties in ranking keep this order. */
export const PALETTE_COMMANDS: readonly PaletteCommand[] = Object.freeze([
  command({
    id: "view-download",
    title: "Download",
    subtitle: "Send to Telegram through DigiBot",
    icon: "download",
    run: { kind: "view", view: "download" },
    path: "Lens",
    verb: "Open",
  }),
  command({
    id: "view-verify",
    title: "Verify",
    subtitle: "Check provenance",
    icon: "shield-check",
    run: { kind: "view", view: "verify" },
    path: "Lens",
    verb: "Open",
  }),
  command({
    id: "view-clip",
    title: "Clip",
    subtitle: "Send part of a video",
    icon: "scissors",
    run: { kind: "view", view: "clip" },
    path: "Lens",
    verb: "Open",
  }),
  command({
    id: "view-recent",
    title: "Recent",
    subtitle: "Your last actions",
    icon: "clock",
    run: { kind: "view", view: "recent" },
    path: "Lens",
    verb: "Open",
  }),
  command({
    id: "view-settings",
    title: "Settings",
    subtitle: "DigiBot, verification, privacy, keys",
    icon: "sliders",
    run: { kind: "view", view: "settings" },
    path: "Lens",
    verb: "Open",
  }),
  command({
    id: "send-page-video",
    title: "Send video",
    subtitle: "Up to 1080p → Telegram",
    icon: "film",
    run: { kind: "start", actionId: LINK_ACTION_ID },
    alias: "d",
    needs: ["link", "digibot"],
    path: "Download · this page",
    leaf: true,
    verb: "Send",
  }),
  command({
    id: "send-page-audio",
    title: "Send voice note",
    subtitle: "Opus → Telegram",
    icon: "mic",
    run: {
      kind: "start",
      actionId: LINK_ACTION_ID,
      options: { output: "voice" },
    },
    alias: "a",
    needs: ["link", "digibot"],
    path: "Download · this page",
    leaf: true,
    verb: "Send",
  }),
  command({
    id: "send-page-audio-file",
    title: "Send audio file",
    subtitle: "Title and player → Telegram",
    icon: "music",
    run: {
      kind: "start",
      actionId: LINK_ACTION_ID,
      options: { output: "m4a" },
    },
    alias: "af",
    needs: ["link", "digibot"],
    path: "Download · this page",
    leaf: true,
    verb: "Send",
  }),
  command({
    id: "open-clip",
    title: "Send clip…",
    subtitle: "Choose start and end",
    icon: "scissors",
    run: { kind: "view", view: "clip" },
    alias: "c",
    needs: ["link", "digibot"],
    path: "Clip · this page",
    leaf: true,
    verb: "Open",
  }),
  command({
    // The click decides: an image goes out as the image download, a video as
    // the video pick.
    id: "pick-media-telegram",
    title: "Pick to download…",
    subtitle: "Click an image or a video",
    icon: "download",
    run: { kind: "start", actionId: DOWNLOAD_ACTION_ID },
    alias: "p",
    needs: ["page", "digibot"],
    path: "Download · pick on the page",
    leaf: true,
    verb: "Run",
  }),
  command({
    id: "pick-post-audio",
    title: "Pick a post → voice note…",
    subtitle: "Click a post that shows a video",
    icon: "mic",
    run: {
      kind: "start",
      actionId: PICK_VIDEO_ACTION_ID,
      options: { output: "voice" },
    },
    alias: "pa",
    needs: ["page", "digibot"],
    path: "Download · pick on the page",
    leaf: true,
    verb: "Run",
  }),
  command({
    id: "pick-post-audio-file",
    title: "Pick a post → audio file…",
    subtitle: "Click a post that shows a video",
    icon: "music",
    run: {
      kind: "start",
      actionId: PICK_VIDEO_ACTION_ID,
      options: { output: "m4a" },
    },
    alias: "paf",
    needs: ["page", "digibot"],
    path: "Download · pick on the page",
    leaf: true,
    verb: "Run",
  }),
  command({
    id: "pick-image",
    title: "Pick an image to verify…",
    subtitle: "Click an image on the page",
    icon: "shield-check",
    run: { kind: "start", actionId: ACTION_ID },
    alias: "v",
    needs: ["page"],
    path: "Verify",
    leaf: true,
    verb: "Run",
  }),
  command({
    id: "check-synthid",
    title: "Check with Google SynthID…",
    subtitle: "Lens saves the file and opens Google's site",
    icon: "image",
    run: { kind: "start", actionId: SYNTHID_ACTION_ID },
    alias: "g",
    needs: ["page", "downloads"],
    path: "Verify",
    leaf: true,
    verb: "Run",
    note: SYNTHID_ROW_NOTE,
    external: true,
  }),
  command({
    id: "verify-page-audio",
    title: "Verify audio of this page…",
    subtitle: "1 to 60 s · DigiBot check",
    icon: "waveform",
    run: { kind: "view", view: "audio-range" },
    alias: "vs",
    needs: ["page", "digibot"],
    path: "Verify · this page",
    leaf: true,
    verb: "Open",
  }),
  command({
    id: "verify-audio-file",
    title: "Verify an audio file…",
    subtitle: "MP3, OGG, Opus, AAC, FLAC or WAV, up to 60 s",
    icon: "mic",
    // Without options the audio action opens audio.html in a tab.
    run: { kind: "start", actionId: AUDIO_ACTION_ID },
    alias: "va",
    path: "Verify",
    leaf: true,
    verb: "Open",
    external: true,
  }),
  command({
    id: "send-clip",
    title: "Send clip of this page",
    subtitle: "Choose start and end → Telegram",
    icon: "scissors",
    run: { kind: "start", actionId: LINK_ACTION_ID, range: true },
    needs: ["link", "digibot", "range"],
    path: "Clip",
    verb: "Send",
  }),
  command({
    id: "pick-post-clip",
    title: "Pick a post, then send its clip…",
    subtitle: "Click a post that shows a video",
    icon: "link",
    run: { kind: "start", actionId: PICK_VIDEO_ACTION_ID, range: true },
    alias: "cp",
    needs: ["page", "digibot", "range"],
    path: "Clip",
    verb: "Run",
  }),
  command({
    id: "verify-clip-audio",
    title: "Verify this clip's audio",
    subtitle: "DigiBot check",
    icon: "waveform",
    run: { kind: "start", actionId: AUDIO_ACTION_ID, range: true },
    needs: ["page", "digibot", "range"],
    path: "Clip",
    verb: "Run",
  }),
  command({
    id: "open-history",
    title: "Result history",
    subtitle: "Filter, delete, DigiBot checks",
    icon: "clock",
    run: { kind: "tab", page: "history" },
    alias: "h",
    path: "Recent",
    leaf: true,
    verb: "Open",
  }),
  command({
    id: "cancel-active",
    title: "Cancel verification",
    subtitle: "Stop the running check",
    icon: "x",
    run: { kind: "cancel" },
    path: "Verify",
    verb: "Run",
  }),
]);

const commandsById = new Map(
  PALETTE_COMMANDS.map((entry) => [entry.id, entry]),
);

export function paletteCommand(id: string): PaletteCommand | undefined {
  return commandsById.get(id);
}

/** The commands a browser key can be bound to (⌘K › Set hotkey…). */
export function isDeclaredCommand(id: string): id is DeclaredCommandId {
  return (DECLARED_COMMAND_IDS as readonly string[]).includes(id);
}

// Aliases and Last used ------------------------------------------------------

export type PalettePrefs = {
  /** A user's alias, or null when they cleared the default one. */
  aliases: Readonly<Record<string, string | null>>;
  /** Leaf command ids, the most recent first. */
  lastUsed: readonly string[];
};

const MAX_LAST_USED = 3;
/** Last used entries of the two picks that "Pick to download…" replaced. */
const RENAMED_COMMANDS: Readonly<Record<string, string>> = {
  "pick-post-video": "pick-media-telegram",
  "pick-image-telegram": "pick-media-telegram",
};
const ALIAS_PATTERN = /^[a-z0-9-]{1,12}$/u;
export const ALIAS_RULE = "1 to 12 characters: a–z, 0–9 and -.";

export function parsePalettePrefs(value: unknown): PalettePrefs {
  const record =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const aliases: Record<string, string | null> = {};
  if (typeof record["aliases"] === "object" && record["aliases"] !== null) {
    for (const [id, alias] of Object.entries(
      record["aliases"] as Record<string, unknown>,
    )) {
      if (!commandsById.has(id)) continue;
      if (
        alias === null ||
        (typeof alias === "string" && ALIAS_PATTERN.test(alias))
      )
        aliases[id] = alias;
    }
  }
  const lastUsed = Array.isArray(record["lastUsed"])
    ? record["lastUsed"]
        .map((id: unknown) =>
          typeof id === "string" ? (RENAMED_COMMANDS[id] ?? id) : id,
        )
        .filter(
          (id): id is string =>
            typeof id === "string" && commandsById.get(id)?.leaf === true,
        )
    : [];
  return { aliases, lastUsed: [...new Set(lastUsed)].slice(0, MAX_LAST_USED) };
}

/** Each command's alias after the user's changes; a cleared alias is absent. */
export function effectiveAliases(
  prefs: PalettePrefs,
): Readonly<Record<string, string>> {
  const aliases: Record<string, string> = {};
  for (const entry of PALETTE_COMMANDS) {
    const alias =
      entry.id in prefs.aliases ? prefs.aliases[entry.id] : entry.alias;
    if (alias) aliases[entry.id] = alias;
  }
  return aliases;
}

export type AliasCheck =
  { ok: true; alias: string | null } | { ok: false; message: string };

/**
 * A new alias for one command: 1 to 12 characters from a–z, 0–9 and "-",
 * used by no other command. An empty value clears the alias.
 */
export function checkAlias(
  text: string,
  commandId: string,
  aliases: Readonly<Record<string, string>>,
): AliasCheck {
  const alias = text.trim().toLowerCase();
  if (alias === "") return { ok: true, alias: null };
  if (!ALIAS_PATTERN.test(alias)) return { ok: false, message: ALIAS_RULE };
  const owner = Object.entries(aliases).find(
    ([id, existing]) => existing === alias && id !== commandId,
  );
  if (owner)
    return {
      ok: false,
      message: `Already used by ${paletteCommand(owner[0])?.title ?? owner[0]}`,
    };
  return { ok: true, alias };
}

export function withAlias(
  prefs: PalettePrefs,
  commandId: string,
  alias: string | null,
): PalettePrefs {
  const defaultAlias = paletteCommand(commandId)?.alias ?? null;
  const aliases = { ...prefs.aliases };
  if (alias === defaultAlias) delete aliases[commandId];
  else aliases[commandId] = alias;
  return { ...prefs, aliases };
}

export function withLastUsed(
  prefs: PalettePrefs,
  commandId: string,
): PalettePrefs {
  if (paletteCommand(commandId)?.leaf !== true) return prefs;
  return {
    ...prefs,
    lastUsed: [
      commandId,
      ...prefs.lastUsed.filter((id) => id !== commandId),
    ].slice(0, MAX_LAST_USED),
  };
}

// Ranking ------------------------------------------------------------------

/**
 * How well a query matches one row, higher first, 0 for no match:
 * exact alias, alias prefix, title prefix, word start, substring, then a
 * subsequence that loses a point for each skipped character.
 */
export function matchScore(
  query: string,
  title: string,
  alias?: string,
): number {
  const needle = query.trim().toLowerCase();
  if (needle === "") return 1;
  const text = title.toLowerCase();
  if (alias !== undefined && alias === needle) return 6000;
  if (alias?.startsWith(needle)) return 5000;
  if (text.startsWith(needle)) return 4000;
  if (text.split(/[^a-z0-9]+/u).some((word) => word.startsWith(needle)))
    return 3000;
  if (text.includes(needle)) return 2000;
  let gaps = 0;
  let index = -1;
  for (const character of needle) {
    const next = text.indexOf(character, index + 1);
    if (next < 0) return 0;
    if (index >= 0) gaps += next - index - 1;
    index = next;
  }
  return Math.max(1, 1000 - gaps);
}

/**
 * Rows that match a query, best first. Ties go to Last used, then to the
 * order the rows came in.
 */
export function rankRows<
  T extends { title: string; alias?: string; id: string },
>(query: string, rows: readonly T[], lastUsed: readonly string[]): T[] {
  const recency = (id: string): number => {
    const index = lastUsed.indexOf(id);
    return index < 0 ? lastUsed.length : index;
  };
  return rows
    .map((row, order) => ({
      row,
      order,
      score: matchScore(query, row.title, row.alias),
    }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        recency(left.row.id) - recency(right.row.id) ||
        left.order - right.order,
    )
    .map(({ row }) => row);
}

// Gating -------------------------------------------------------------------

export type PaletteContext = {
  host: "page" | "popup" | "tab";
  page: "web" | "link-only" | "none";
  hostname: string;
  scope: "page" | "video";
  needsPick: boolean;
  connected: boolean;
  downloadAccess: boolean;
  /** The Verify row's value: "DigiBot check", "API check" or "OpenAI Verify site". */
  verifyMode: string;
  range: ClipRangeResult | null;
};

export type Gate = {
  reason: string;
  /** The row truly cannot run here; ↵ does nothing. */
  disabled: boolean;
  /** What ↵ opens instead. */
  fix?: CommandRun;
};

export const NO_PAGE_REASON = "Open a normal web page to use this.";
const BROWSER_PAGE_REASON = "Not on browser pages";

/** Why a command cannot run as it is, or null when it can. */
export function commandGate(
  entry: PaletteCommand,
  context: PaletteContext,
): Gate | null {
  const needs = entry.needs ?? [];
  const noPage = context.host === "tab" ? NO_PAGE_REASON : BROWSER_PAGE_REASON;
  if (needs.includes("page") && context.page !== "web")
    return { reason: noPage, disabled: true };
  if (needs.includes("link") && context.page === "none")
    return { reason: noPage, disabled: true };
  if (needs.includes("digibot") && !context.connected)
    return {
      reason: "Needs DigiBot",
      disabled: false,
      fix: { kind: "view", view: "connect" },
    };
  if (needs.includes("downloads") && !context.downloadAccess)
    return {
      reason: "Needs download access",
      disabled: false,
      fix: { kind: "view", view: "access" },
    };
  if (needs.includes("range") && context.range?.ok !== true)
    return { reason: "Enter a range first", disabled: true };
  return null;
}

/** m:ss, or h:mm:ss from one hour. */
export function formatClock(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
    : `${minutes}:${rest}`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

/** The audio segment limit (1 to 60 s) a range must fit for an audio check. */
export function fitsAudioCheck(range: ClipRangeResult | null): boolean {
  if (!range?.ok) return false;
  const length = range.endSeconds - range.startSeconds;
  return length >= 1 && length <= 60;
}

export { parseClockRange };

// Keys ---------------------------------------------------------------------

/**
 * One browser shortcut as keycaps: "Alt+Shift+V" on Windows and Linux, and
 * "⌥⇧V" on a Mac, where the modifiers come as single symbols.
 */
export function shortcutKeys(shortcut: string): string[] {
  if (shortcut === "") return [];
  if (shortcut.includes("+")) return shortcut.split("+").filter(Boolean);
  const keys: string[] = [];
  let rest = shortcut;
  while (rest.length > 1 && "⌃⌥⇧⌘".includes(rest.charAt(0))) {
    keys.push(rest.charAt(0));
    rest = rest.slice(1);
  }
  return [...keys, rest];
}

export type PaletteKeyEvent = {
  key: string;
  code: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode: number;
  isTrusted: boolean;
};

export type PaletteKeyState = {
  actionsOpen: boolean;
  query: string;
  depth: number;
};

export type PaletteKey =
  | { type: "none" }
  | { type: "move"; delta: 1 | -1 }
  | { type: "edge"; edge: "first" | "last" }
  | { type: "run" }
  | { type: "digit"; index: number }
  | { type: "actions" }
  | {
      type: "escape";
      step: "close-actions" | "clear-query" | "back" | "close";
    }
  | { type: "back" }
  | { type: "tab"; backward: boolean };

const DIGIT_CODE = /^(?:Digit|Numpad)([1-9])$/u;

/**
 * What one key does in the palette. Untrusted events do nothing, and
 * while an IME composes only Tab stays trapped; "none" leaves the key to the
 * input. Every other result is handled with preventDefault().
 */
export function paletteKey(
  event: PaletteKeyEvent,
  state: PaletteKeyState,
): PaletteKey {
  if (!event.isTrusted) return { type: "none" };
  const { altKey, ctrlKey, metaKey, shiftKey } = event;
  if (event.key === "Tab" && !altKey && !ctrlKey && !metaKey)
    return { type: "tab", backward: shiftKey };
  // The IME owns Enter, arrows and Esc while it composes.
  if (event.isComposing || event.keyCode === 229) return { type: "none" };
  const digit = DIGIT_CODE.exec(event.code)?.[1];
  // ⌥1–⌥9 by the physical key, so the layout's character is never typed.
  if (digit !== undefined && altKey && !ctrlKey && !metaKey && !shiftKey)
    return { type: "digit", index: Number(digit) - 1 };
  if (event.key === "Escape") {
    if (state.actionsOpen) return { type: "escape", step: "close-actions" };
    if (state.query !== "") return { type: "escape", step: "clear-query" };
    return { type: "escape", step: state.depth > 0 ? "back" : "close" };
  }
  if (event.code === "KeyK" && (metaKey || ctrlKey) && !altKey && !shiftKey)
    return { type: "actions" };
  if (ctrlKey && !metaKey && !altKey && !shiftKey) {
    if (event.code === "KeyN") return { type: "move", delta: 1 };
    if (event.code === "KeyP") return { type: "move", delta: -1 };
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (metaKey)
      return {
        type: "edge",
        edge: event.key === "ArrowDown" ? "last" : "first",
      };
    if (!altKey && !ctrlKey && !shiftKey)
      return { type: "move", delta: event.key === "ArrowDown" ? 1 : -1 };
  }
  if (event.key === "Enter" && !altKey && !ctrlKey && !metaKey)
    return { type: "run" };
  if (
    event.key === "Backspace" &&
    state.query === "" &&
    state.depth > 0 &&
    !altKey &&
    !ctrlKey &&
    !metaKey
  )
    return { type: "back" };
  return { type: "none" };
}

/** The next Tab stop, wrapping at both ends, so focus never leaves the frame. */
export function nextTabStop(
  current: number,
  count: number,
  backward: boolean,
): number {
  if (count <= 0) return -1;
  if (current < 0) return backward ? count - 1 : 0;
  return (current + (backward ? count - 1 : 1)) % count;
}
