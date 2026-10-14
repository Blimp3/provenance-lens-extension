import {
  ACTION_ID,
  AUDIO_ACTION_ID,
  DOWNLOAD_ACTION_ID,
  LINK_ACTION_ID,
  PICK_VIDEO_ACTION_ID,
  SYNTHID_ACTION_ID,
  sanitizeDisplayText,
  type ActionId,
  type ActivityEntry,
  type ActivityKind,
  type ActivityState,
  type ErrorCode,
  type LinkDownloadOptions,
} from "@provenance-lens/shared";

import {
  getSettings,
  startActivity,
  updateActivity,
  type ActivityUpdate,
} from "./storage.js";
import { PALETTE_COMMANDS, type IconName } from "./ui/palette-commands.js";

/**
 * Recent's entries: one per action the user starts from the palette, a key,
 * a right-click item or a toast button. The worker writes the entry when the
 * action starts and its state when it ends.
 */

/** Recent's entry for a run; null when history keeps nothing. */
export type ActivityId = string | null;

/** What an action whose palette row is gone is called. */
const FALLBACK_TITLES: Readonly<Record<ActionId, string>> = {
  [ACTION_ID]: "Verify an image",
  [AUDIO_ACTION_ID]: "Verify audio",
  [DOWNLOAD_ACTION_ID]: "Send an image",
  [LINK_ACTION_ID]: "Send this page",
  [PICK_VIDEO_ACTION_ID]: "Send the picked video",
  [SYNTHID_ACTION_ID]: "Check with Google SynthID",
};

/** How many entries Recent shows. */
export const RECENT_LIMIT = 8;

const KIND_ICONS: Readonly<Record<ActivityKind, IconName>> = {
  image: "image",
  video: "film",
  "audio-file": "music",
  voice: "mic",
  "page-link": "link",
  verify: "shield-check",
  clip: "scissors",
};

const STATE_LABELS: Readonly<Record<ActivityState, string>> = {
  running: "Started",
  sent: "Sent",
  done: "Done",
  failed: "Failed",
  refused: "Refused",
};

/** What ↵ on a Recent entry opens; null when it left nothing to open. */
export type RecentOpen =
  | { page: "details"; recordId: string }
  | { page: "history" }
  | { page: "address"; url: string }
  | null;

export type RecentRow = {
  title: string;
  subtitle: string;
  icon: IconName;
  state: string;
  warn: boolean;
  open: RecentOpen;
};

/** Codes Lens gives when it declines to run, not when the run fails. */
const REFUSAL_CODES: ReadonlySet<ErrorCode> = new Set([
  "protected_page",
  "backend_configuration_missing",
  "concurrency_limit",
  "permission_denied",
  "unsupported_image_type",
  "image_too_large",
  "unsupported_audio_type",
  "audio_too_large",
  "audio_too_long",
]);

/** The palette row's title for a started action, without its "…". */
export function activityTitle(
  actionId: ActionId,
  options: LinkDownloadOptions = {},
): string {
  const range = options.startSeconds !== undefined;
  const entry = PALETTE_COMMANDS.find(
    ({ run }) =>
      run.kind === "start" &&
      run.actionId === actionId &&
      Boolean(run.range) === range &&
      run.options?.output === options.output,
  );
  return entry ? entry.title.replace(/…$/u, "") : FALLBACK_TITLES[actionId];
}

/**
 * The kind a link send ends as: its clip or audio output, else the video,
 * which is "page-link" when the tab's own address goes out.
 */
export function linkActivityKind(
  options: LinkDownloadOptions,
  video: "video" | "page-link",
): ActivityKind {
  if (options.startSeconds !== undefined) return "clip";
  if (options.output === "voice") return "voice";
  if (options.output === "m4a" || options.output === "mp3") return "audio-file";
  return video;
}

/**
 * The kind an action starts as. The download pick starts as an image and
 * becomes a video or a page link when the click picks one.
 */
export function startActivityKind(
  actionId: ActionId,
  options: LinkDownloadOptions = {},
): ActivityKind {
  switch (actionId) {
    case LINK_ACTION_ID:
      return linkActivityKind(options, "page-link");
    case PICK_VIDEO_ACTION_ID:
      return linkActivityKind(options, "video");
    case DOWNLOAD_ACTION_ID:
      return "image";
    default:
      return "verify";
  }
}

/** How an action stopped by this error code ended. */
export function refusalState(code: ErrorCode): ActivityState {
  return REFUSAL_CODES.has(code) ? "refused" : "failed";
}

/**
 * An address as Recent keeps it: http(s) only, without a fragment or
 * credentials, which can carry tokens; null for anything else.
 */
export function activityAddress(url: string | undefined): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url ?? "");
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  const address = parsed.toString();
  return address.length <= 2_048 ? address : null;
}

/** A new running entry; the page title only when history keeps titles. */
export function activityEntry(start: {
  title: string;
  kind: ActivityKind;
  tab?: Pick<chrome.tabs.Tab, "id" | "url" | "title"> | null | undefined;
  includePageTitle: boolean;
}): ActivityEntry {
  const tab = start.tab ?? null;
  const tabId =
    tab?.id !== undefined && Number.isSafeInteger(tab.id) && tab.id >= 0
      ? tab.id
      : null;
  const pageUrl = activityAddress(tab?.url);
  return {
    id: crypto.randomUUID(),
    title: sanitizeDisplayText(start.title, 80) || "Lens action",
    kind: start.kind,
    tabId,
    pageTitle:
      start.includePageTitle && pageUrl !== null
        ? sanitizeDisplayText(tab?.title ?? "", 256) || null
        : null,
    pageUrl,
    linkUrl: null,
    startedAt: new Date().toISOString(),
    state: "running",
    message: null,
    operationId: null,
    recordId: null,
  };
}

/** Writes Recent's entry for an action that starts; null when none is kept. */
export async function beginActivity(
  title: string,
  kind: ActivityKind,
  tab?: Pick<chrome.tabs.Tab, "id" | "url" | "title"> | null,
): Promise<ActivityId> {
  try {
    const settings = await getSettings();
    const entry = activityEntry({
      title,
      kind,
      tab,
      includePageTitle: settings.includePageTitle,
    });
    await startActivity(entry, settings.historyRetention);
    return settings.historyRetention === 0 ? null : entry.id;
  } catch {
    // Recent is a record of what ran; the action itself still runs.
    return null;
  }
}

/** Records what the run picked or how it ended; best effort. */
export async function noteActivity(
  id: ActivityId,
  update: ActivityUpdate,
): Promise<void> {
  if (id === null) return;
  await updateActivity(id, update).catch(() => undefined);
}

/**
 * Recent's row for an entry. ↵ opens a Verify result's details while history
 * keeps its record (a connected check's in Result history), Result history
 * for a DigiBot send, and the address a page link sent.
 */
export function recentRow(
  entry: ActivityEntry,
  savedRecordIds: ReadonlySet<string>,
  when: string,
): RecentRow {
  // A sent entry's message only repeats its state; an ended one says why.
  const ended = entry.state !== "running" && entry.state !== "sent";
  const place =
    entry.pageTitle ?? hostOf(entry.linkUrl ?? entry.pageUrl) ?? "This device";
  return {
    title: entry.title,
    subtitle: [ended ? entry.message : null, place, when]
      .filter(Boolean)
      .join(" · "),
    icon: KIND_ICONS[entry.kind],
    state: STATE_LABELS[entry.state],
    warn: entry.state === "failed" || entry.state === "refused",
    open: recentOpen(entry, savedRecordIds),
  };
}

function recentOpen(
  entry: ActivityEntry,
  savedRecordIds: ReadonlySet<string>,
): RecentOpen {
  if (entry.kind === "verify") {
    if (entry.recordId !== null && savedRecordIds.has(entry.recordId))
      return { page: "details", recordId: entry.recordId };
    return entry.operationId === null ? null : { page: "history" };
  }
  if (entry.kind === "page-link") {
    const url = activityAddress(entry.linkUrl ?? entry.pageUrl ?? undefined);
    return url === null ? null : { page: "address", url };
  }
  return { page: "history" };
}

function hostOf(address: string | null): string | null {
  if (address === null) return null;
  try {
    return new URL(address).hostname || null;
  } catch {
    return null;
  }
}
