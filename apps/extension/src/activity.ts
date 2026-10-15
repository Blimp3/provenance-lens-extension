import {
  ACTION_ID,
  AUDIO_ACTION_ID,
  DOWNLOAD_ACTION_ID,
  LINK_ACTION_ID,
  PICK_VIDEO_ACTION_ID,
  SYNTHID_ACTION_ID,
  resultLabel,
  sanitizeDisplayText,
  type ActionId,
  type ActivityEntry,
  type ActivityKind,
  type ActivityState,
  type ErrorCode,
  type IntegrationOperationStatus,
  type LinkDownloadOptions,
} from "@provenance-lens/shared";

import { httpAddress, pageAddress } from "./page-address.js";
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
 * action starts and its state when it ends; the audio page does both for its
 * own checks.
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

/** How an entry ends when Lens stopped before the action did. */
export const STOPPED_MESSAGE = "Lens stopped before this action ended.";

/** No action runs this long; Recent shows an older running entry as ended. */
export const STALE_ACTIVITY_MS = 10 * 60 * 1_000;

/** An extension page holds this lock while an entry it runs is running. */
const ACTIVITY_LOCK_PREFIX = "provenance-lens.activity:";

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
  cancelled: "Cancelled",
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
 * What Telegram gets from a link send, whichever address went out: the clip,
 * the voice note, the audio file or the video.
 */
export function linkActivityKind(options: LinkDownloadOptions): ActivityKind {
  if (options.startSeconds !== undefined) return "clip";
  if (options.output === "voice") return "voice";
  if (options.output === "m4a" || options.output === "mp3") return "audio-file";
  return "video";
}

/**
 * The kind an action starts as. The download pick's output is not known
 * until its click picks an image or a video.
 */
export function startActivityKind(
  actionId: ActionId,
  options: LinkDownloadOptions = {},
): ActivityKind {
  switch (actionId) {
    case LINK_ACTION_ID:
    case PICK_VIDEO_ACTION_ID:
      return linkActivityKind(options);
    case DOWNLOAD_ACTION_ID:
      return "page-link";
    default:
      return "verify";
  }
}

/** How an action stopped by this error code ended. */
export function refusalState(code: ErrorCode): ActivityState {
  return REFUSAL_CODES.has(code) ? "refused" : "failed";
}

/**
 * The address a link send sent, as Recent keeps it to open it again: http(s)
 * only, its query included, without a fragment or credentials; null for
 * anything else.
 */
export function activityAddress(url: string | undefined): string | null {
  const parsed = httpAddress(url);
  if (!parsed) return null;
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
  const pageUrl = pageAddress(tab?.url);
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

/** This page's held entries, each with its lock's release. */
const heldEntries = new Map<string, () => void>();
/** The entries this worker or page started since it loaded. */
const startedHere = new Set<string>();

/**
 * Whether this worker or page started the entry since it loaded, which a
 * clock step cannot change.
 */
export function startedSinceLoad(id: string): boolean {
  return startedHere.has(id);
}

/**
 * Writes Recent's entry for an action that starts; null when none is kept.
 * An extension page that runs the action itself (the audio page) holds the
 * entry with a lock until it ends, so the worker's start-up sweep leaves it
 * running; the browser drops the lock when the page closes.
 */
export async function beginActivity(
  title: string,
  kind: ActivityKind,
  tab?: Pick<chrome.tabs.Tab, "id" | "url" | "title"> | null,
  options: { held?: boolean } = {},
): Promise<ActivityId> {
  try {
    const settings = await getSettings();
    const entry = activityEntry({
      title,
      kind,
      tab,
      includePageTitle: settings.includePageTitle,
    });
    const kept = settings.historyRetention !== 0;
    startedHere.add(entry.id);
    if (kept && options.held) await holdEntry(entry.id);
    // With history off this clears the list instead.
    await startActivity(entry, settings.historyRetention);
    return kept ? entry.id : null;
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
  if (update.state !== undefined && update.state !== "running") {
    heldEntries.get(id)?.();
    heldEntries.delete(id);
  }
}

/** Resolves once this page holds the entry's lock, or at once without one. */
async function holdEntry(id: string): Promise<void> {
  try {
    await new Promise<void>((granted, refused) => {
      navigator.locks
        .request(
          `${ACTIVITY_LOCK_PREFIX}${id}`,
          () =>
            new Promise<void>((release) => {
              heldEntries.set(id, release);
              granted();
            }),
        )
        .catch(refused);
    });
  } catch {
    // Without Web Locks the sweep may end the entry early; it still runs.
  }
}

/** The entries an extension page holds while it runs them. */
export async function heldActivityIds(): Promise<ReadonlySet<string>> {
  try {
    const { held = [] } = await navigator.locks.query();
    return new Set(
      held.flatMap(({ name }) =>
        name?.startsWith(ACTIVITY_LOCK_PREFIX)
          ? [name.slice(ACTIVITY_LOCK_PREFIX.length)]
          : [],
      ),
    );
  } catch {
    return new Set();
  }
}

/** How a DigiBot operation ended or stands, as Recent shows it. */
export function operationUpdate(
  status: IntegrationOperationStatus,
  mediaKind: "image" | "audio",
): ActivityUpdate {
  const evidence = status.envelope?.result?.evidence;
  const audio = mediaKind === "audio";
  if (evidence)
    return {
      state: "done",
      message: resultLabel(evidence, mediaKind),
      operationId: status.operationId,
    };
  if (status.state === "failed")
    return {
      state: "failed",
      message:
        status.error?.message ??
        (audio
          ? "The audio could not be checked."
          : "DigiBot could not finish this action."),
      operationId: status.operationId,
    };
  return {
    state: "sent",
    message:
      status.error?.message ??
      (audio
        ? "The audio check is still processing."
        : status.action === "download"
          ? "The image was sent to your DigiBot chat."
          : "The connected check is still processing in DigiBot."),
    operationId: status.operationId,
  };
}

/**
 * Recent's row for an entry. ↵ opens a Verify result's details while history
 * keeps its record (a connected check's in Result history), the address a
 * link send sent, and Result history for another DigiBot send. A running
 * entry older than STALE_ACTIVITY_MS shows as stopped.
 */
export function recentRow(
  entry: ActivityEntry,
  savedRecordIds: ReadonlySet<string>,
  when: string,
  now = Date.now(),
): RecentRow {
  const shown =
    entry.state === "running" &&
    now - Date.parse(entry.startedAt) > STALE_ACTIVITY_MS
      ? { ...entry, state: "failed" as const, message: STOPPED_MESSAGE }
      : entry;
  // A sent or cancelled entry's message only repeats its state; an ended
  // one says why.
  const ended = !["running", "sent", "cancelled"].includes(shown.state);
  const place =
    shown.pageTitle ?? hostOf(shown.linkUrl ?? shown.pageUrl) ?? "This device";
  return {
    title: shown.title,
    subtitle: [ended ? shown.message : null, place, when]
      .filter(Boolean)
      .join(" · "),
    icon: KIND_ICONS[shown.kind],
    state: STATE_LABELS[shown.state],
    warn: shown.state === "failed" || shown.state === "refused",
    open: recentOpen(shown, savedRecordIds),
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
  // A link send opens the address it sent, whatever Telegram got from it.
  const url = activityAddress(entry.linkUrl ?? undefined);
  if (url !== null) return { page: "address", url };
  return entry.kind === "page-link" ? null : { page: "history" };
}

function hostOf(address: string | null): string | null {
  if (address === null) return null;
  try {
    return new URL(address).hostname || null;
  } catch {
    return null;
  }
}
