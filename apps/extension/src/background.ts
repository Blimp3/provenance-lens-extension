import {
  ACTION_ID,
  DISCLOSURE_VERSION,
  DOWNLOAD_ACTION_ID,
  ExtensionMessageSchema,
  ImageSelectionSchema,
  LinkDownloadOptionsSchema,
  MAX_IMAGE_BYTES,
  PICK_VIDEO_ACTION_ID,
  PICKER_RUNTIME_VERSION,
  ResultToastBindingsSchema,
  VerificationModeSchema,
  makeIndeterminateResult,
  originPattern,
  parseAllowedImageUrl,
  sanitizeDisplayText,
  sha256Hex,
  type ActionId,
  type ExtensionMessage,
  type ErrorCode,
  type ImageSelection,
  type LinkDownloadOptions,
  type PickerRuntimeMessage,
  type VerificationMode,
} from "@provenance-lens/shared";

import { getActionDefinition } from "./actions/registry.js";
import {
  PAGE_LINK_QUEUED_MESSAGE,
  pageLinkErrorMessage,
  type PageLinkSource,
} from "./actions/integration-link.js";
import { pickedLinkUrl } from "./page-link-candidates.js";
import {
  createHistoryRecord,
  ExtensionWorkflowError,
  verifyRetrievedImage,
  type RetrievedImage,
  type VerificationOutcome,
  USER_CANCELLED_REASON,
} from "./actions/verify-openai-provenance.js";
import {
  appendHistory,
  getHistory,
  getLatestRecord,
  getResult,
  getSettings,
  STORAGE_KEYS,
  setWorkflowState,
  updateSettings,
} from "./storage.js";
import {
  detectedToastCopy,
  errorToastCopy,
  matchesResultToastBinding,
  noSignalToastCopy,
  removePageResultToastBindings,
  removeResultToastBinding,
  resultDetailsUrl,
  sameResultToastBinding,
  upsertResultToastBinding,
  type ResultToastBinding,
} from "./notifications.js";
import { isProtectedPage } from "./page-policy.js";
import {
  resolveCancellationTabId,
  routeActionRequest,
  type ActionTrigger,
} from "./routing.js";
import {
  samePageBinding,
  type PageSnapshot,
  type SelectionFingerprint,
  type SelectionRectFingerprint,
} from "./screenshot-binding.js";
import { boundedExpiredIds, unretainedIds } from "./fallback-retention.js";
import { readBoundedResponseBytes } from "./bounded-response.js";
import {
  assertScreenshotDataUrlBudget,
  assertScreenshotPixelBudget,
} from "./screenshot-guard.js";
import { VerificationRunRegistry } from "./verification-runs.js";
import {
  disclosureModesMatch,
  hasVerificationModeAcknowledgement,
  isExpectedVerificationMode,
} from "./disclosure-policy.js";
import {
  API_MODE_REQUIRED_MESSAGE,
  isApiVerificationAuthorized,
} from "./api-verification-policy.js";
import { openActionPopup } from "./action-popup.js";
import {
  isIntegrationConnected,
  IntegrationClientError,
  resumePendingIntegrationOperations,
} from "./integration-client.js";
import { runIntegratedImageAction } from "./actions/integration-image.js";
import type { IntegrationOperationStatus } from "@provenance-lens/shared";

type PageTarget = {
  sessionToken: string;
  tabId: number;
  frameId: number;
  documentId: string;
};

type ImageActionId = typeof ACTION_ID | typeof DOWNLOAD_ACTION_ID;

/** Sends one page link: the registry's page-link and video-pick handlers. */
type PageLinkSender = (
  page: PageLinkSource,
  options: LinkDownloadOptions,
) => Promise<void>;

type ImagePickerSession = {
  mode: "image";
  actionId: ImageActionId;
  trigger: ActionTrigger;
  verificationMode: VerificationMode;
};
/** A video pick: the clicked post's link goes out with the popup's output. */
type LinkPickerSession = {
  mode: "link";
  options: LinkDownloadOptions;
  send: PageLinkSender;
};
type PickerSession = PageTarget & (ImagePickerSession | LinkPickerSession);

type PendingDisclosure = {
  id: string;
  actionId: typeof ACTION_ID;
  tabId: number;
  frameId: number;
  trigger: ActionTrigger;
  verificationMode: VerificationMode;
  selection: ImageSelection | null;
  pageTarget: PageTarget | null;
};

const PENDING_DISCLOSURES_KEY = "provenanceLens.pendingDisclosures";
/**
 * Link picks outlive the service worker: Chrome stops an idle worker after
 * about 30 s, and a user scrolls a timeline before clicking. Image picks need
 * no record; their selection arrives with the page still bound.
 */
const LINK_PICKER_SESSIONS_KEY = "provenanceLens.linkPickerSessions";
const MAX_LINK_PICKER_SESSIONS = 8;

type FallbackImage = {
  image: RetrievedImage;
  tabId: number;
  windowId: number;
  createdAt: number;
};

type ScreenshotFallback = {
  historySource: Pick<ImageSelection, "sourceHostname" | "pageTitle">;
  tabId: number;
  windowId: number;
  frameId: 0;
  page: BoundPageSnapshot;
  pageTarget: PageTarget | null;
  createdAt: number;
};

type ShowToastMessage = Extract<PickerRuntimeMessage, { type: "show-toast" }>;
type PageToast = Omit<
  ShowToastMessage,
  "type" | "runtimeVersion" | "sessionToken"
>;

type BoundPageSnapshot = PageSnapshot & { selection: SelectionFingerprint };

type CapturedSelectionFingerprint = Omit<
  SelectionFingerprint,
  "sourceUrlSha256"
> & { url: string };

type CapturedPageSnapshot = Omit<
  PageSnapshot,
  "pageUrlSha256" | "selection"
> & {
  url: string;
  selection: CapturedSelectionFingerprint | null;
};

const pickerSessions = new Map<string, PickerSession>();
/** Link picks already taken or cancelled; a replay is refused after the guard. */
const spentLinkPicks = new Set<string>();
const MAX_SPENT_LINK_PICKS = 32;
const pendingDisclosures = new Map<string, PendingDisclosure>();
const activeVerifications = new VerificationRunRegistry();
const fallbackImages = new Map<string, FallbackImage>();
const screenshotFallbacks = new Map<string, ScreenshotFallback>();
const badgeTimers = new Map<number, ReturnType<typeof setTimeout>>();
const MAX_FALLBACK_IMAGES = 2;
const MAX_FALLBACK_TOTAL_BYTES = 50 * 1024 * 1024;
const FALLBACK_IMAGE_TTL_MS = 5 * 60 * 1_000;
const MAX_SCREENSHOT_FALLBACKS = 10;
const SCREENSHOT_FALLBACK_TTL_MS = 5 * 60 * 1_000;
const SCREENSHOT_TIMEOUT_MS = 20_000;
const MAX_RESULT_TOAST_BINDINGS = 32;
const RESULT_TOAST_BINDINGS_KEY = "provenanceLens.resultToastBindings";
let resultToastBindingMutation = Promise.resolve();

chrome.runtime.onInstalled.addListener(() => {
  void ensureTrustedStorageAccess();
  void ensureContextMenu();
  void resumePendingIntegrationOperations();
});
chrome.runtime.onStartup.addListener(() => {
  void ensureTrustedStorageAccess();
  void ensureContextMenu();
  void resumePendingIntegrationOperations();
});
void ensureTrustedStorageAccess();
void ensureContextMenu();
void resumePendingIntegrationOperations();

chrome.commands.onCommand.addListener((command) => {
  if (command !== "pick-image") return;
  void startFromActiveTab("keyboard");
});

const contextMenus = getContextMenusApi();
if (contextMenus) {
  contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== ACTION_ID || !tab || tab.id === undefined) return;
    void handleContextMenu(info, tab);
  });
}

// Messages that start, resume, cancel or retry a verification come only from
// the extension's own pages (popup, details, disclosure). Picker and result
// toast messages come from content scripts and keep their tab, frame and
// document binding checks instead.
const EXTENSION_PAGE_MESSAGE_TYPES: ReadonlySet<ExtensionMessage["type"]> =
  new Set([
    "start-action",
    "resume-permission",
    "verify-screenshot",
    "download-fallback",
    "cancel-active",
  ]);

chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  const parsed = ExtensionMessageSchema.safeParse(message);
  if (!parsed.success) return false;
  if (
    EXTENSION_PAGE_MESSAGE_TYPES.has(parsed.data.type) &&
    !isExtensionPageSender(sender)
  )
    return false;
  void handleExtensionMessage(parsed.data, sender);
  return false;
});

function isExtensionPageSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.url?.startsWith(chrome.runtime.getURL("")) === true;
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    (areaName === "local" && changes[STORAGE_KEYS.history]) ||
    (areaName === "session" && changes[STORAGE_KEYS.latest])
  ) {
    void pruneFallbacksToStoredRecords();
  }
});

async function handleExtensionMessage(
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  switch (message.type) {
    case "start-action": {
      const action = getActionDefinition(message.actionId);
      if (action?.inputType === "audio-file") {
        try {
          await action.handler();
        } catch {
          await notifyStandaloneError(
            "backend_unavailable",
            "The audio check page could not be opened.",
          );
        }
        return;
      }
      if (action?.inputType === "page-link") {
        await sendPageLinkFromActiveTab(action.handler, message.options ?? {});
        return;
      }
      if (action?.inputType === "video-pick") {
        await startVideoPickFromActiveTab(
          action.handler,
          message.options ?? {},
        );
        return;
      }
      if (action?.inputType !== "image-file") return;
      await startFromActiveTab(
        message.trigger,
        message.actionId as ImageActionId,
      );
      return;
    }
    case "resume-permission":
      await resumeDisclosure(message.pendingId, message.verificationMode);
      return;
    case "picker-selected":
      await handlePickerSelected(message, sender);
      return;
    case "picker-cancelled":
      await handlePickerCancelled(message, sender);
      return;
    case "picker-link-selected":
      await handlePickerLinkSelected(message, sender);
      return;
    case "cancel-active":
      await cancelActiveVerification(sender.tab?.id);
      return;
    case "verify-screenshot":
      await handleScreenshotFallback(message.fallbackId);
      return;
    case "download-fallback":
      await handleDownloadFallback(message.resultId);
      return;
    case "open-result-details":
      await openResultDetails(message, sender);
      return;
    default:
      return;
  }
}

async function startFromActiveTab(
  trigger: "popup" | "keyboard",
  actionId: ImageActionId = ACTION_ID,
): Promise<void> {
  const tabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  const tab = tabs[0];
  if (!tab?.id) {
    await notifyStandaloneError(
      "protected_page",
      "No active browser page is available.",
    );
    return;
  }
  await requestActionOnTab(tab.id, 0, trigger, null, actionId);
}

/** Whether a page link is being sent; a repeated click meanwhile is ignored. */
let pageLinkInFlight = false;

/** Why a picked link was refused before any request; shown on the page. */
const PICKED_LINK_MESSAGE =
  "That link cannot be sent to Telegram. Pick a post that shows a video, a YouTube video or a page link.";
const PAGE_LINK_SENT_TITLE = "Sent to DigiBot";
const PAGE_LINK_FAILED_TITLE = "Page link not sent";

/**
 * The page-link action reports through the workflow state, so the popup stays
 * open; only the toolbar badge is handled here, where its timer lives. The
 * options (an MP3 output or a clip range) travel with the link unchanged.
 */
async function sendPageLinkFromActiveTab(
  send: PageLinkSender,
  options: LinkDownloadOptions = {},
): Promise<void> {
  if (pageLinkInFlight) return;
  const tabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  const tab = tabs[0];
  await deliverPageLink(send, { url: tab?.url }, options, tab?.id, null);
}

/**
 * Sends one link through the page-link action with the in-flight guard and
 * the badge. A picked link also reports on its page, since the popup closed
 * when the picker started; the popup path passes no page target.
 */
async function deliverPageLink(
  send: PageLinkSender,
  page: PageLinkSource,
  options: LinkDownloadOptions,
  tabId: number | undefined,
  pageTarget: PageTarget | null,
): Promise<void> {
  if (pageLinkInFlight) {
    await showPageToast(pageTarget, {
      tone: "error",
      title: PAGE_LINK_FAILED_TITLE,
      message: "Another page link is still being sent.",
      resultId: null,
    });
    return;
  }
  pageLinkInFlight = true;
  try {
    let failure: string | null = null;
    try {
      await send(page, options);
    } catch (error: unknown) {
      // The action already stored this message in the workflow state.
      failure = pageLinkErrorMessage(error);
    }
    if (tabId !== undefined)
      await (failure === null ? clearBadge(tabId) : setBadge(tabId, "!")).catch(
        () => undefined,
      );
    await showPageToast(
      pageTarget,
      failure === null
        ? {
            tone: "detected",
            title: PAGE_LINK_SENT_TITLE,
            message: PAGE_LINK_QUEUED_MESSAGE,
            resultId: null,
          }
        : {
            tone: "error",
            title: PAGE_LINK_FAILED_TITLE,
            message: failure,
            resultId: null,
          },
    );
  } finally {
    pageLinkInFlight = false;
  }
}

/**
 * Starts the picker in link mode on the active tab. The popup closes when it
 * asks, so a refusal here goes to the badge and the workflow state, and the
 * pick itself reports on the page.
 */
async function startVideoPickFromActiveTab(
  send: PageLinkSender,
  options: LinkDownloadOptions,
): Promise<void> {
  const tabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  const tab = tabs[0];
  if (!tab?.id) {
    await notifyStandaloneError(
      "protected_page",
      "No active browser page is available.",
    );
    return;
  }
  const tabId = tab.id;
  if (isProtectedPage(tab.url ?? "")) {
    await notifyStandaloneError(
      "protected_page",
      "Video picking is not supported on this browser page.",
      { tabId },
    );
    return;
  }
  if (!(await isIntegrationConnected())) {
    await notifyStandaloneError(
      "backend_configuration_missing",
      "Connect Provenance Lens to DigiBot in Settings before picking a video.",
      { tabId },
    );
    return;
  }
  try {
    await injectPicker(tabId, 0, { mode: "link", options, send });
    await setWorkflow(
      "picking",
      "Click a post with a video to send its link to Telegram.",
      PICK_VIDEO_ACTION_ID,
    );
  } catch {
    await notifyStandaloneError(
      "permission_denied",
      "The video picker could not access this page.",
      { tabId },
    );
  }
}

async function requestActionOnTab(
  tabId: number,
  frameId: number,
  trigger: ActionTrigger,
  selection: ImageSelection | null = null,
  actionId: ImageActionId = ACTION_ID,
): Promise<void> {
  const action = getActionDefinition(actionId);
  if (!action || action.inputType !== "image-file") {
    await notifyStandaloneError(
      "invalid_request",
      "The requested action is unavailable.",
      { tabId },
    );
    return;
  }
  const tab = await chrome.tabs.get(tabId);
  const pageUrl = tab.url ?? "";
  if (isProtectedPage(pageUrl)) {
    await notifyStandaloneError(
      "protected_page",
      "Image picking is not supported on this browser page.",
      { tabId },
    );
    return;
  }

  if (actionId === DOWNLOAD_ACTION_ID && !(await isIntegrationConnected())) {
    await notifyStandaloneError(
      "backend_configuration_missing",
      "Connect Provenance Lens to DigiBot in Settings before downloading an image.",
      { tabId },
    );
    return;
  }
  const connected = await isIntegrationConnected();
  const pageTarget = selection ? await bindPageTarget(tabId, frameId) : null;
  const settings = await getSettings();
  if (
    !connected &&
    (settings.disclosureVersion < DISCLOSURE_VERSION ||
      !hasVerificationModeAcknowledgement(
        settings.acknowledgedVerificationModes,
        settings.verificationMode,
      ))
  ) {
    await openDisclosure({
      id: crypto.randomUUID(),
      actionId: ACTION_ID,
      tabId,
      frameId,
      trigger,
      verificationMode: settings.verificationMode,
      selection,
      pageTarget,
    });
    return;
  }
  const route = routeActionRequest(trigger, selection);
  if (route.kind === "verify-selection") {
    await executeAction(tabId, frameId, route.selection, {
      actionId,
      page: null,
      expectedVerificationMode: settings.verificationMode,
      trigger,
      pageTarget,
    });
    return;
  }
  try {
    await injectPicker(tabId, frameId, {
      mode: "image",
      actionId,
      trigger,
      verificationMode: settings.verificationMode,
    });
    await setWorkflow(
      "picking",
      actionId === DOWNLOAD_ACTION_ID
        ? "Choose an image to download."
        : "Choose an image to verify.",
      actionId,
    );
  } catch {
    await notifyStandaloneError(
      "permission_denied",
      "The image picker could not access this page.",
      { tabId },
    );
  }
}

async function resumeDisclosure(
  pendingId: string,
  acknowledgedMode: VerificationMode,
): Promise<void> {
  const pending =
    pendingDisclosures.get(pendingId) ??
    (await readPendingDisclosure(pendingId));
  if (!pending) return;

  const settings = await getSettings();
  if (
    !disclosureModesMatch(
      pending.verificationMode,
      acknowledgedMode,
      settings.verificationMode,
    )
  ) {
    pendingDisclosures.delete(pending.id);
    await deletePendingDisclosure(pending.id);
    await openDisclosure({
      ...pending,
      id: crypto.randomUUID(),
      actionId: pending.actionId,
      verificationMode: settings.verificationMode,
    });
    return;
  }

  pendingDisclosures.delete(pendingId);
  await deletePendingDisclosure(pendingId);
  const nextAcknowledgedModes = settings.acknowledgedVerificationModes.includes(
    pending.verificationMode,
  )
    ? settings.acknowledgedVerificationModes
    : [...settings.acknowledgedVerificationModes, pending.verificationMode];
  await updateSettings({
    disclosureVersion: DISCLOSURE_VERSION,
    acknowledgedVerificationModes: nextAcknowledgedModes,
  });
  try {
    if (pending.selection) {
      await executeAction(pending.tabId, pending.frameId, pending.selection, {
        actionId: pending.actionId,
        page: null,
        expectedVerificationMode: acknowledgedMode,
        trigger: pending.trigger,
        pageTarget: pending.pageTarget,
      });
    } else {
      await injectPicker(pending.tabId, pending.frameId, {
        mode: "image",
        actionId: pending.actionId,
        trigger: pending.trigger,
        verificationMode: acknowledgedMode,
      });
      await setWorkflow(
        "picking",
        "Choose an image to verify.",
        pending.actionId,
      );
    }
  } catch {
    await notifyStandaloneError(
      "permission_denied",
      "The image picker could not access this page.",
      { pageTarget: pending.pageTarget, tabId: pending.tabId },
    );
  }
}

async function openDisclosure(pending: PendingDisclosure): Promise<void> {
  pendingDisclosures.set(pending.id, pending);
  await persistPendingDisclosure(pending);
  await chrome.tabs.create({
    url: `${chrome.runtime.getURL("disclosure.html")}?pending=${encodeURIComponent(pending.id)}`,
  });
}

async function persistPendingDisclosure(
  pending: PendingDisclosure,
): Promise<void> {
  try {
    const values = await chrome.storage.session.get(PENDING_DISCLOSURES_KEY);
    const current = isRecord(values[PENDING_DISCLOSURES_KEY])
      ? values[PENDING_DISCLOSURES_KEY]
      : {};
    // Persist only the acknowledgement workflow coordinates. Image URLs and
    // inline bytes stay in the service-worker map and are discarded on
    // suspension; a resumed context-menu request then safely reopens picker.
    current[pending.id] = { ...pending, selection: null, pageTarget: null };
    const entries = Object.entries(current).slice(-8);
    await chrome.storage.session.set({
      [PENDING_DISCLOSURES_KEY]: Object.fromEntries(entries),
    });
  } catch {
    // The in-memory map remains usable if session storage is unavailable.
  }
}

async function readPendingDisclosure(
  id: string,
): Promise<PendingDisclosure | null> {
  try {
    const values = await chrome.storage.session.get(PENDING_DISCLOSURES_KEY);
    const current = values[PENDING_DISCLOSURES_KEY];
    if (!isRecord(current)) return null;
    const candidate = current[id];
    if (!isRecord(candidate)) return null;
    if (
      typeof candidate["id"] !== "string" ||
      candidate["id"] !== id ||
      typeof candidate["tabId"] !== "number" ||
      typeof candidate["frameId"] !== "number" ||
      candidate["actionId"] !== ACTION_ID ||
      !["popup", "keyboard", "context-menu"].includes(
        String(candidate["trigger"]),
      )
    )
      return null;
    const parsedMode = VerificationModeSchema.safeParse(
      candidate["verificationMode"],
    );
    if (!parsedMode.success && candidate["verificationMode"] !== undefined)
      return null;
    // Pending entries written before hybrid mode had no mode field. Resume
    // those only against the currently configured mode, whose disclosure is
    // what the upgraded page renders; all other malformed values fail closed.
    const verificationMode = parsedMode.success
      ? parsedMode.data
      : (await getSettings()).verificationMode;
    const selection =
      candidate["selection"] === null
        ? null
        : ImageSelectionSchema.safeParse(candidate["selection"]);
    if (candidate["selection"] !== null && (!selection || !selection.success))
      return null;
    return {
      id,
      actionId: ACTION_ID,
      tabId: candidate["tabId"],
      frameId: candidate["frameId"],
      trigger: candidate["trigger"] as PendingDisclosure["trigger"],
      verificationMode,
      pageTarget: null,
      selection:
        candidate["selection"] === null
          ? null
          : (selection as { success: true; data: ImageSelection }).data,
    };
  } catch {
    return null;
  }
}

async function deletePendingDisclosure(id: string): Promise<void> {
  try {
    const values = await chrome.storage.session.get(PENDING_DISCLOSURES_KEY);
    const current = isRecord(values[PENDING_DISCLOSURES_KEY])
      ? values[PENDING_DISCLOSURES_KEY]
      : {};
    delete current[id];
    await chrome.storage.session.set({ [PENDING_DISCLOSURES_KEY]: current });
  } catch {
    // Best effort; pending disclosures are short-lived session state.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function persistLinkPickerSession(
  session: PageTarget & LinkPickerSession,
): Promise<void> {
  try {
    const values = await chrome.storage.session.get(LINK_PICKER_SESSIONS_KEY);
    const current = isRecord(values[LINK_PICKER_SESSIONS_KEY])
      ? values[LINK_PICKER_SESSIONS_KEY]
      : {};
    // Only the serialisable coordinates; the handler is rebuilt on restore.
    const { sessionToken, tabId, frameId, documentId, mode, options } = session;
    current[sessionToken] = {
      sessionToken,
      tabId,
      frameId,
      documentId,
      mode,
      options,
    };
    const entries = Object.entries(current).slice(-MAX_LINK_PICKER_SESSIONS);
    await chrome.storage.session.set({
      [LINK_PICKER_SESSIONS_KEY]: Object.fromEntries(entries),
    });
  } catch {
    // The in-memory map still serves the pick while this worker lives.
  }
}

/**
 * A link pick this worker no longer holds, rebuilt around the registry's
 * video-pick handler; null when nothing valid was stored for the token.
 */
async function restoreLinkPickerSession(
  sessionToken: string,
): Promise<PickerSession | null> {
  try {
    const values = await chrome.storage.session.get(LINK_PICKER_SESSIONS_KEY);
    const current = values[LINK_PICKER_SESSIONS_KEY];
    if (!isRecord(current)) return null;
    const stored = current[sessionToken];
    if (
      !isRecord(stored) ||
      stored["sessionToken"] !== sessionToken ||
      stored["mode"] !== "link" ||
      typeof stored["tabId"] !== "number" ||
      typeof stored["frameId"] !== "number" ||
      typeof stored["documentId"] !== "string"
    )
      return null;
    const options = LinkDownloadOptionsSchema.safeParse(
      stored["options"] ?? {},
    );
    if (!options.success) return null;
    const action = getActionDefinition(PICK_VIDEO_ACTION_ID);
    if (action?.inputType !== "video-pick") return null;
    return {
      mode: "link",
      sessionToken,
      tabId: stored["tabId"],
      frameId: stored["frameId"],
      documentId: stored["documentId"],
      options: options.data,
      send: action.handler,
    };
  } catch {
    return null;
  }
}

async function forgetLinkPickerSession(sessionToken: string): Promise<void> {
  try {
    const values = await chrome.storage.session.get(LINK_PICKER_SESSIONS_KEY);
    const current = values[LINK_PICKER_SESSIONS_KEY];
    if (!isRecord(current) || !(sessionToken in current)) return;
    delete current[sessionToken];
    await chrome.storage.session.set({ [LINK_PICKER_SESSIONS_KEY]: current });
  } catch {
    // Best effort; a stale record is refused by the spent set or evicted.
  }
}

/**
 * The live or stored session for a picker message, before the sender guard.
 * A spent token may still come back from storage; spendLinkPick refuses it.
 */
async function findPickerSession(
  sessionToken: string,
): Promise<PickerSession | undefined> {
  return (
    pickerSessions.get(sessionToken) ??
    (await restoreLinkPickerSession(sessionToken)) ??
    undefined
  );
}

/** Claims a link pick once: false when it was already taken or cancelled. */
function spendLinkPick(sessionToken: string): boolean {
  if (spentLinkPicks.has(sessionToken)) return false;
  spentLinkPicks.add(sessionToken);
  if (spentLinkPicks.size > MAX_SPENT_LINK_PICKS) {
    const oldest = spentLinkPicks.values().next().value;
    if (oldest !== undefined) spentLinkPicks.delete(oldest);
  }
  return true;
}

async function bindPageTarget(
  tabId: number,
  frameId: number,
): Promise<PageTarget | null> {
  const sessionToken = crypto.randomUUID();
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: ["picker.js"],
    });
    const injected = results.find((result) => result.frameId === frameId);
    if (!injected?.documentId) return null;
    const target = {
      sessionToken,
      tabId,
      frameId,
      documentId: injected.documentId,
    };
    await chrome.tabs.sendMessage(
      tabId,
      {
        type: "page-bind",
        runtimeVersion: PICKER_RUNTIME_VERSION,
        sessionToken,
      } satisfies PickerRuntimeMessage,
      { documentId: target.documentId },
    );
    return target;
  } catch {
    return null;
  }
}

async function injectPicker(
  tabId: number,
  frameId: number,
  session: ImagePickerSession | LinkPickerSession,
): Promise<void> {
  const target = await bindPageTarget(tabId, frameId);
  if (!target) throw new Error("The picker could not access this page.");
  pickerSessions.set(target.sessionToken, { ...session, ...target });
  if (session.mode === "link")
    await persistLinkPickerSession({ ...session, ...target });
  try {
    await chrome.tabs.sendMessage(
      tabId,
      {
        type: "picker-start",
        runtimeVersion: PICKER_RUNTIME_VERSION,
        sessionToken: target.sessionToken,
        // An image pick is the runtime's default and keeps the older message.
        ...(session.mode === "link" ? { mode: session.mode } : {}),
      } satisfies PickerRuntimeMessage,
      { documentId: target.documentId },
    );
  } catch (error: unknown) {
    pickerSessions.delete(target.sessionToken);
    if (session.mode === "link")
      await forgetLinkPickerSession(target.sessionToken);
    throw error;
  }
}

async function handlePickerSelected(
  message: Extract<ExtensionMessage, { type: "picker-selected" }>,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const session = pickerSessions.get(message.sessionToken);
  if (
    !session ||
    session.mode !== "image" ||
    sender.tab?.id !== session.tabId ||
    sender.frameId !== session.frameId ||
    sender.documentId !== session.documentId
  )
    return;
  pickerSessions.delete(message.sessionToken);
  const selection = ImageSelectionSchema.safeParse(message.selection);
  if (!selection.success) {
    await notifyStandaloneError(
      "image_retrieval_failed",
      "The selected image information is invalid.",
      { pageTarget: session, tabId: session.tabId },
    );
    return;
  }
  await stopPicker(session);
  const page =
    session.frameId === 0
      ? await bindPageSnapshot(
          session.tabId,
          session.frameId,
          selection.data.url,
          selection.data.rect,
        )
      : null;
  await executeAction(session.tabId, session.frameId, selection.data, {
    actionId: session.actionId,
    page,
    expectedVerificationMode: session.verificationMode,
    reopenPopupWhenComplete: true,
    trigger: session.trigger,
    pageTarget: session,
  });
}

async function handlePickerCancelled(
  message: Extract<ExtensionMessage, { type: "picker-cancelled" }>,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const session = await findPickerSession(message.sessionToken);
  if (
    !session ||
    sender.tab?.id !== session.tabId ||
    sender.frameId !== session.frameId ||
    sender.documentId !== session.documentId
  )
    return;
  if (session.mode === "link" && !spendLinkPick(message.sessionToken)) return;
  pickerSessions.delete(message.sessionToken);
  await stopPicker(session);
  await setWorkflow(
    "idle",
    session.mode === "link"
      ? "Video pick cancelled."
      : "Image selection cancelled.",
  );
  await clearBadge(session.tabId);
}

/**
 * A picked link from the bound picker session goes out like the page link,
 * with the output chosen in the popup. The session may come back from storage
 * after a worker restart; either way it is taken exactly once. The address is
 * checked again here, so an X timeline or profile address is never sent.
 */
async function handlePickerLinkSelected(
  message: Extract<ExtensionMessage, { type: "picker-link-selected" }>,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const session = await findPickerSession(message.sessionToken);
  if (
    !session ||
    session.mode !== "link" ||
    sender.tab?.id !== session.tabId ||
    sender.frameId !== session.frameId ||
    sender.documentId !== session.documentId
  )
    return;
  if (!spendLinkPick(message.sessionToken)) return;
  pickerSessions.delete(message.sessionToken);
  await stopPicker(session);
  const url = pickedLinkUrl(message.url);
  if (url === null) {
    await setWorkflow("error", PICKED_LINK_MESSAGE, PICK_VIDEO_ACTION_ID);
    await setBadge(session.tabId, "!").catch(() => undefined);
    await showPageToast(session, {
      tone: "error",
      title: PAGE_LINK_FAILED_TITLE,
      message: PICKED_LINK_MESSAGE,
      resultId: null,
    });
    return;
  }
  await deliverPageLink(
    session.send,
    { url },
    session.options,
    session.tabId,
    session,
  );
}

async function stopPicker(session: PickerSession): Promise<void> {
  if (session.mode === "link")
    await forgetLinkPickerSession(session.sessionToken);
  try {
    await chrome.tabs.sendMessage(
      session.tabId,
      {
        type: "picker-stop",
        runtimeVersion: PICKER_RUNTIME_VERSION,
        sessionToken: session.sessionToken,
      },
      { documentId: session.documentId },
    );
  } catch {
    // The picker cleans itself up before sending a selection or cancellation.
  }
}

async function handleContextMenu(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab,
): Promise<void> {
  const tabId = tab.id;
  if (tabId === undefined) return;
  if (!info.srcUrl) {
    await requestActionOnTab(tabId, info.frameId ?? 0, "context-menu");
    return;
  }
  const selection = contextMenuSelection(info.srcUrl, tab.url ?? "");
  if (!selection) {
    await notifyStandaloneError(
      "image_retrieval_failed",
      "The context-menu image URL is invalid.",
      { tabId },
    );
    return;
  }
  await requestActionOnTab(tabId, info.frameId ?? 0, "context-menu", selection);
}

function contextMenuSelection(
  srcUrl: string,
  pageUrl: string,
): ImageSelection | null {
  try {
    const url = parseAllowedImageUrl(srcUrl);
    const page = new URL(pageUrl);
    const pageOrigin = ["http:", "https:"].includes(page.protocol)
      ? page.origin
      : "https://invalid.local";
    const sourceKind: ImageSelection["sourceKind"] =
      url.protocol === "data:"
        ? "data-url"
        : url.protocol === "blob:"
          ? "blob-url"
          : "img";
    return ImageSelectionSchema.parse({
      url: srcUrl,
      sourceKind,
      pageOrigin,
      sourceHostname: page.hostname || "unknown",
      pageTitle: null,
      rect: {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        viewportWidth: 1,
        viewportHeight: 1,
        devicePixelRatio: 1,
      },
    });
  } catch {
    return null;
  }
}

async function executeAction(
  tabId: number,
  frameId: number,
  selection: ImageSelection,
  options: {
    actionId?: ImageActionId;
    page: BoundPageSnapshot | null;
    pageTarget: PageTarget | null;
    expectedVerificationMode?: VerificationMode;
    reopenPopupWhenComplete?: boolean;
    trigger?: ActionTrigger;
  } = { page: null, pageTarget: null },
): Promise<void> {
  const actionId = options.actionId ?? ACTION_ID;
  const action = getActionDefinition(actionId);
  if (!action || action.inputType !== "image-file") {
    await notifyStandaloneError(
      "invalid_request",
      "The requested action is unavailable.",
      { pageTarget: options.pageTarget, tabId },
    );
    return;
  }
  const active = activeVerifications.claim(tabId);
  if (!active) {
    await notifyStandaloneError(
      "concurrency_limit",
      "An image is already being verified in this tab.",
      { pageTarget: options.pageTarget, tabId },
    );
    return;
  }
  let settings: Awaited<ReturnType<typeof getSettings>> | null = null;
  let transientApiImage: RetrievedImage | null = null;
  let historyPersisted = false;
  let integratedAction = false;
  try {
    settings = await getSettings();
    const connected = await isIntegrationConnected();
    if (actionId === DOWNLOAD_ACTION_ID && !connected) {
      await notifyStandaloneError(
        "backend_configuration_missing",
        "Connect Provenance Lens to DigiBot in Settings before downloading an image.",
        { pageTarget: options.pageTarget, tabId },
      );
      return;
    }
    if (
      !connected &&
      (!isExpectedVerificationMode(
        options.expectedVerificationMode,
        settings.verificationMode,
      ) ||
        !hasVerificationModeAcknowledgement(
          settings.acknowledgedVerificationModes,
          settings.verificationMode,
        ))
    ) {
      await openDisclosure({
        id: crypto.randomUUID(),
        actionId: ACTION_ID,
        tabId,
        frameId,
        trigger: options.trigger ?? "popup",
        verificationMode: settings.verificationMode,
        selection,
        pageTarget: options.pageTarget,
      });
      return;
    }
    await setWorkflow(
      "retrieving",
      "Retrieving the original image bytes.",
      actionId,
    );
    await setBadge(tabId, "…");
    if (connected || actionId === DOWNLOAD_ACTION_ID) {
      integratedAction = true;
      const integrated = await runIntegratedImageAction(
        actionId === DOWNLOAD_ACTION_ID ? "download" : "check",
        selection,
        {
          signal: active.controller.signal,
          hasHostPermission: (url) =>
            hasImageHostPermission(tabId, url, selection.pageOrigin),
        },
      );
      await finishIntegratedImageAction(
        tabId,
        integrated.status,
        options.pageTarget,
        actionId,
      );
      return;
    }
    const execution = await action.handler({
      selection,
      settings,
      retrieval: {
        signal: active.controller.signal,
        screenshotFallbackAvailable: options.page !== null,
        hasHostPermission: (url) =>
          hasImageHostPermission(tabId, url, selection.pageOrigin),
      },
    });
    if (execution.kind === "website") {
      if (execution.status === "error") {
        await notifyStandaloneError(execution.errorCode, execution.message, {
          pageTarget: options.pageTarget,
          tabId,
        });
      } else {
        await setWorkflow("idle", execution.message);
        await clearBadge(tabId);
      }
      return;
    }
    if (execution.kind === "integration") {
      await finishIntegratedImageAction(
        tabId,
        execution.outcome.status,
        options.pageTarget,
        actionId,
      );
      return;
    }
    const outcome = execution.outcome;
    transientApiImage = outcome.retrieved;
    const record = createHistoryRecord(
      selection,
      outcome,
      settings.includePageTitle,
    );
    active.historyId = record.id;
    await appendHistory(record, settings.historyRetention);
    historyPersisted = true;
    if (outcome.retrieved && outcome.manualFallbackAvailable) {
      const tab = await chrome.tabs.get(tabId);
      retainFallbackImage(
        record.id,
        outcome.retrieved,
        tabId,
        tab.windowId ?? -1,
      );
      transientApiImage = null;
    }
    if (outcome.screenshotFallbackAvailable && options.page) {
      const tab = await chrome.tabs.get(tabId);
      screenshotFallbacks.set(record.id, {
        historySource: {
          sourceHostname: record.sourceHostname,
          pageTitle: record.pageTitle,
        },
        tabId,
        windowId: tab.windowId ?? -1,
        frameId: 0,
        page: options.page,
        pageTarget: options.pageTarget,
        createdAt: Date.now(),
      });
      pruneScreenshotFallbacks();
    }
    await finishVerification(tabId, record.id, outcome, options.pageTarget);
    if (
      options.reopenPopupWhenComplete &&
      outcome.errorCode !== "user_cancelled"
    )
      await openActionPopup(tabId, record);
  } catch (error: unknown) {
    if (integratedAction) {
      const message =
        error instanceof IntegrationClientError
          ? error.message
          : "The connected DigiBot operation could not be completed.";
      await notifyStandaloneError("backend_unavailable", message, {
        pageTarget: options.pageTarget,
        tabId,
      });
      await clearBadge(tabId).catch(() => undefined);
      return;
    }
    if (active.historyId) {
      await notifyPostResultFailure(
        tabId,
        options.pageTarget,
        historyPersisted,
      );
      return;
    }
    // Website mode intentionally has no normalized result, history record, or
    // cache entry. Keep an unexpected action failure on the same boundary.
    if (settings?.verificationMode === "website") {
      await notifyStandaloneError(
        "invalid_request",
        "The Website verification workflow could not be completed.",
        { pageTarget: options.pageTarget, tabId },
      );
      return;
    }
    const outcome: VerificationOutcome = {
      result: makeIndeterminateResult(
        "The verification workflow could not be completed.",
      ),
      imageSha256: null,
      cache: null,
      errorCode: "backend_unavailable",
      retrieved: null,
      manualFallbackAvailable: false,
      screenshotFallbackAvailable: false,
    };
    const record = createHistoryRecord(
      selection,
      outcome,
      settings?.includePageTitle ?? false,
    );
    await appendHistory(record, settings?.historyRetention ?? 20);
    await finishVerification(tabId, record.id, outcome, options.pageTarget);
    if (options.reopenPopupWhenComplete) await openActionPopup(tabId, record);
  } finally {
    transientApiImage?.bytes.fill(0);
    activeVerifications.release(tabId, active.controller);
  }
}

async function notifyPostResultFailure(
  tabId: number,
  pageTarget: PageTarget | null,
  historyPersisted: boolean,
): Promise<void> {
  const message = historyPersisted
    ? "The verification result was saved, but its display could not be completed."
    : "The verification result could not be saved or displayed.";
  await notifyStandaloneError("invalid_request", message, {
    pageTarget,
    tabId,
  }).catch(() => undefined);
  await clearBadge(tabId).catch(() => undefined);
}

async function finishIntegratedImageAction(
  tabId: number,
  status: IntegrationOperationStatus,
  pageTarget: PageTarget | null,
  actionId: ImageActionId,
): Promise<void> {
  if (actionId === DOWNLOAD_ACTION_ID) {
    const message =
      status.state === "failed"
        ? "The image could not be delivered to your DigiBot chat."
        : archiveStatusMessage(
            status,
            "The image was sent to your DigiBot chat.",
          );
    await setWorkflow(
      status.state === "failed" ? "error" : "idle",
      status.error?.message ?? message,
      actionId,
    );
    if (status.state === "failed") await setBadge(tabId, "!");
    else await clearBadge(tabId);
    await showPageToast(pageTarget, {
      tone: status.state === "failed" ? "error" : "no-signal",
      title: status.state === "failed" ? "Download failed" : "Download status",
      message: status.error?.message ?? message,
      resultId: null,
    });
    return;
  }

  const result = status.envelope?.result?.evidence;
  if (result) {
    const copy = noSignalToastCopy(result);
    const detected = result.verdict === "openai_signal_detected";
    const archiveMessage = archiveStatusMessage(
      status,
      "The checked original was saved to your DigiBot chat.",
    );
    await setWorkflow(
      "idle",
      sanitizeDisplayText(
        `${copy.title}. ${result.summary} ${archiveMessage}`,
        512,
      ),
      actionId,
    );
    await setBadge(
      tabId,
      detected ? "✓" : result.verdict === "indeterminate" ? "!" : "?",
    );
    await showPageToast(pageTarget, {
      tone:
        result.verdict === "indeterminate"
          ? "error"
          : detected
            ? "detected"
            : "no-signal",
      title: copy.title,
      message: sanitizeDisplayText(`${result.summary} ${archiveMessage}`, 512),
      resultId: null,
    });
    return;
  }

  if (status.state === "failed") {
    await setWorkflow(
      "error",
      status.error?.message ?? "The connected check could not be completed.",
      actionId,
    );
    await setBadge(tabId, "!");
    await showPageToast(pageTarget, {
      tone: "error",
      title: "Connected check failed",
      message:
        status.error?.message ?? "The connected check could not be completed.",
      resultId: null,
    });
    return;
  }

  const message =
    "The connected check is still processing. Its result will appear in History.";
  await setWorkflow("idle", message, actionId);
  await clearBadge(tabId);
  await showPageToast(pageTarget, {
    tone: "no-signal",
    title: "Check accepted",
    message,
    resultId: null,
  });
}

function archiveStatusMessage(
  status: IntegrationOperationStatus,
  confirmedMessage: string,
): string {
  if (
    status.archive.deliveryState === "confirmed" &&
    status.archive.integrityState === "verified"
  )
    return confirmedMessage;
  if (status.archive.deliveryState === "unknown")
    return "Telegram delivery status is unknown; open History to reconcile it.";
  if (status.archive.deliveryState === "failed")
    return "Telegram delivery failed; open History for recovery options.";
  return "Telegram delivery is still pending.";
}

async function finishVerification(
  tabId: number,
  resultId: string,
  outcome: VerificationOutcome,
  pageTarget: PageTarget | null,
): Promise<void> {
  if (outcome.errorCode === "user_cancelled") {
    await setWorkflow("idle", "Verification cancelled.");
    await clearBadge(tabId);
    return;
  }
  const credentials = outcome.result.contentCredentials;
  if (credentials?.status === "verified" || credentials?.status === "invalid") {
    const copy = noSignalToastCopy(outcome.result);
    const detected =
      outcome.result.verdict === "openai_signal_detected" ||
      (credentials.signerTrusted && credentials.aiDeclaration !== null);
    await setWorkflow(
      "idle",
      sanitizeDisplayText(`${copy.title}. ${outcome.result.summary}`, 512),
    );
    await setBadge(
      tabId,
      detected ? "✓" : credentials.status === "invalid" ? "!" : "?",
    );
    await showPageToast(pageTarget, {
      tone: detected
        ? "detected"
        : credentials.status === "invalid"
          ? "error"
          : "no-signal",
      title: copy.title,
      message: copy.message,
      resultId,
    });
    return;
  }
  if (outcome.errorCode) {
    await setWorkflow(
      "error",
      sanitizeDisplayText(outcome.result.summary, 512),
    );
    await setBadge(tabId, "!");
    await notifyErrorResult(resultId, outcome.result.summary, pageTarget);
    return;
  }
  await setWorkflow("idle", outcome.result.summary);
  if (outcome.result.verdict === "openai_signal_detected") {
    await setBadge(tabId, "✓");
    await notifyDetectedResult(resultId, outcome.result, pageTarget);
  } else if (outcome.result.verdict === "no_supported_openai_signal") {
    await setBadge(tabId, "?");
    await notifyNoSignalResult(resultId, pageTarget);
  } else {
    await setBadge(tabId, "!");
    await notifyErrorResult(resultId, outcome.result.summary, pageTarget);
  }
}

async function handleScreenshotFallback(fallbackId: string): Promise<void> {
  pruneScreenshotFallbacks();
  const fallback = screenshotFallbacks.get(fallbackId);
  if (!fallback) {
    await notifyStandaloneError(
      "image_retrieval_failed",
      "The screenshot fallback is no longer available.",
    );
    return;
  }
  const active = activeVerifications.claim(fallback.tabId);
  if (!active) {
    await notifyStandaloneError(
      "concurrency_limit",
      "An image is already being verified in this tab.",
      { pageTarget: fallback.pageTarget, tabId: fallback.tabId },
    );
    return;
  }
  let capturedImage: RetrievedImage | null = null;
  let historyPersisted = false;
  try {
    const settings = await getSettings();
    if (!isApiVerificationAuthorized(settings)) {
      await notifyStandaloneError(
        "permission_denied",
        API_MODE_REQUIRED_MESSAGE,
        { pageTarget: fallback.pageTarget, tabId: fallback.tabId },
      );
      return;
    }
    if (!settings.screenshotFallbackEnabled) {
      await notifyStandaloneError(
        "permission_denied",
        "Enable screenshot fallback in Settings first.",
        { pageTarget: fallback.pageTarget, tabId: fallback.tabId },
      );
      return;
    }
    screenshotFallbacks.delete(fallbackId);
    await setWorkflow("retrieving", "Creating the requested screenshot copy.");
    await setBadge(fallback.tabId, "…");
    capturedImage = await withScreenshotDeadline(
      active.controller.signal,
      (signal) => captureScreenshotImage(fallback, signal),
    );
    if (!capturedImage) return;
    const outcome = await verifySelectionWithImage(
      settings,
      capturedImage,
      active.controller.signal,
    );
    const record = createHistoryRecord(
      fallback.historySource,
      outcome,
      settings.includePageTitle,
      "screenshot_copy",
    );
    active.historyId = record.id;
    await appendHistory(record, settings.historyRetention);
    historyPersisted = true;
    if (capturedImage && outcome.manualFallbackAvailable) {
      retainFallbackImage(
        record.id,
        capturedImage,
        fallback.tabId,
        fallback.windowId,
      );
      capturedImage = null;
    }
    await finishVerification(
      fallback.tabId,
      record.id,
      outcome,
      fallback.pageTarget,
    );
  } catch (error: unknown) {
    if (active.historyId) {
      await notifyPostResultFailure(
        fallback.tabId,
        fallback.pageTarget,
        historyPersisted,
      );
      return;
    }
    if (
      error instanceof ExtensionWorkflowError &&
      error.code === "user_cancelled"
    ) {
      await setWorkflow("idle", "Verification cancelled.");
      await clearBadge(fallback.tabId);
      return;
    }
    await notifyStandaloneError(
      "request_timeout",
      error instanceof Error
        ? error.message
        : "The screenshot copy could not be created.",
      { pageTarget: fallback.pageTarget, tabId: fallback.tabId },
    );
  } finally {
    capturedImage?.bytes.fill(0);
    activeVerifications.release(fallback.tabId, active.controller);
  }
}

async function verifySelectionWithImage(
  settings: Awaited<ReturnType<typeof getSettings>>,
  image: RetrievedImage,
  signal: AbortSignal,
): Promise<VerificationOutcome> {
  return verifyRetrievedImage(image, settings, { signal });
}

async function withScreenshotDeadline<T>(
  parentSignal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectParent: ((reason?: unknown) => void) | undefined;
  const abortFromParent = (): void => {
    controller.abort(USER_CANCELLED_REASON);
    rejectParent?.(
      new ExtensionWorkflowError(
        "user_cancelled",
        "Verification cancelled by the user.",
      ),
    );
  };
  const parentPromise = new Promise<never>((_, reject) => {
    rejectParent = reject;
    if (parentSignal.aborted) abortFromParent();
    else
      parentSignal.addEventListener("abort", abortFromParent, { once: true });
  });
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort("provenance-lens-screenshot-deadline");
      reject(
        new ExtensionWorkflowError(
          "request_timeout",
          "The screenshot copy took too long to create.",
          true,
        ),
      );
    }, SCREENSHOT_TIMEOUT_MS);
  });
  const operationPromise = operation(controller.signal);
  try {
    return await Promise.race([
      operationPromise,
      timeoutPromise,
      parentPromise,
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abortFromParent);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason === USER_CANCELLED_REASON) {
    throw new ExtensionWorkflowError(
      "user_cancelled",
      "Verification cancelled by the user.",
    );
  }
  throw new ExtensionWorkflowError(
    "request_timeout",
    "The screenshot copy took too long to create.",
    true,
  );
}

async function captureScreenshotImage(
  fallback: ScreenshotFallback,
  signal: AbortSignal,
): Promise<RetrievedImage | null> {
  let restoreTabId: number | null = null;
  try {
    throwIfAborted(signal);
    const tab = await chrome.tabs.get(fallback.tabId);
    if (
      !tab.url ||
      (await sha256Text(tab.url)) !== fallback.page.pageUrlSha256
    ) {
      throw new Error(
        "The original page changed before the screenshot could be created.",
      );
    }
    const currentPage = await readBoundPageSnapshot(
      fallback.tabId,
      fallback.frameId,
      fallback.page.selection.rect,
    );
    throwIfAborted(signal);
    if (!currentPage || !samePageBinding(currentPage, fallback.page)) {
      throw new Error(
        "The original page changed before the screenshot could be created.",
      );
    }
    const activeTabs = await chrome.tabs.query({
      active: true,
      windowId: fallback.windowId,
    });
    const activeTabId = activeTabs[0]?.id;
    if (activeTabId !== fallback.tabId) {
      await chrome.tabs.update(fallback.tabId, { active: true });
      restoreTabId = activeTabId ?? null;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    throwIfAborted(signal);
    const finalTab = await chrome.tabs.get(fallback.tabId);
    const finalPage = await readBoundPageSnapshot(
      fallback.tabId,
      fallback.frameId,
      fallback.page.selection.rect,
    );
    if (
      !finalTab.url ||
      (await sha256Text(finalTab.url)) !== fallback.page.pageUrlSha256 ||
      !finalPage ||
      !samePageBinding(finalPage, fallback.page)
    ) {
      throw new Error(
        "The original page changed before the screenshot could be created.",
      );
    }
    if (
      typeof createImageBitmap !== "function" ||
      typeof OffscreenCanvas !== "function"
    ) {
      throw new Error("Screenshot cropping is unavailable in this browser.");
    }
    assertScreenshotPixelBudget(
      fallback.page.viewportWidth,
      fallback.page.viewportHeight,
      fallback.page.devicePixelRatio,
      MAX_IMAGE_BYTES,
    );
    const dataUrl = await chrome.tabs.captureVisibleTab(fallback.windowId, {
      format: "png",
    });
    throwIfAborted(signal);
    assertScreenshotDataUrlBudget(dataUrl, MAX_IMAGE_BYTES);
    const response = await fetch(dataUrl, {
      credentials: "omit",
      signal,
    });
    const sourceBytes = await readBoundedResponseBytes(
      response,
      MAX_IMAGE_BYTES,
      signal,
    );
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(
        new Blob([sourceBytes], { type: "image/png" }),
      );
      throwIfAborted(signal);
      const dpr = fallback.page.devicePixelRatio;
      const selectionRect = fallback.page.selection.rect;
      const sx = Math.max(0, Math.floor(selectionRect.x * dpr));
      const sy = Math.max(0, Math.floor(selectionRect.y * dpr));
      const sw = Math.max(
        1,
        Math.min(bitmap.width - sx, Math.ceil(selectionRect.width * dpr)),
      );
      const sh = Math.max(
        1,
        Math.min(bitmap.height - sy, Math.ceil(selectionRect.height * dpr)),
      );
      if (sx >= bitmap.width || sy >= bitmap.height)
        throw new Error("The selected image is outside the visible area.");
      const canvas = new OffscreenCanvas(sw, sh);
      const context = canvas.getContext("2d");
      if (!context)
        throw new Error("Screenshot cropping is unavailable in this browser.");
      context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
      const blob = await canvas.convertToBlob({ type: "image/png" });
      throwIfAborted(signal);
      if (blob.size > MAX_IMAGE_BYTES)
        throw new Error("The screenshot copy exceeds the permitted size.");
      const bytes = await readBoundedResponseBytes(
        new Response(blob),
        MAX_IMAGE_BYTES,
        signal,
      );
      throwIfAborted(signal);
      return {
        bytes,
        mime: "image/png",
        filename: "screenshot-copy.png",
        sourceUrl: "screenshot-copy",
      };
    } finally {
      sourceBytes.fill(0);
      bitmap?.close();
    }
  } catch (error: unknown) {
    if (signal.aborted) throwIfAborted(signal);
    if (
      error instanceof ExtensionWorkflowError &&
      error.code === "user_cancelled"
    )
      throw error;
    await notifyStandaloneError(
      "image_retrieval_failed",
      error instanceof Error
        ? error.message
        : "The screenshot copy could not be created.",
      { pageTarget: fallback.pageTarget, tabId: fallback.tabId },
    );
    return null;
  } finally {
    if (restoreTabId !== null && restoreTabId !== fallback.tabId) {
      try {
        await chrome.tabs.update(restoreTabId, { active: true });
      } catch {
        // The previously active tab may have been closed while capturing.
      }
    }
  }
}

async function bindPageSnapshot(
  tabId: number,
  frameId: number,
  selectionUrl: string,
  selectionRect: SelectionRectFingerprint,
): Promise<BoundPageSnapshot | null> {
  try {
    const documentMarker = crypto.randomUUID();
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: capturePageSnapshotInDocument,
      args: [documentMarker, selectionRect],
    });
    const value = results[0]?.result;
    if (!isCapturedPageSnapshot(value) || !value.selection) return null;
    const page = await hashPageSnapshot(value);
    const expectedSourceUrlSha256 = await sha256Text(selectionUrl);
    return page.selection?.sourceUrlSha256 === expectedSourceUrlSha256
      ? (page as BoundPageSnapshot)
      : null;
  } catch {
    return null;
  }
}

async function readBoundPageSnapshot(
  tabId: number,
  frameId: number,
  selectionRect: SelectionRectFingerprint,
): Promise<PageSnapshot | null> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: capturePageSnapshotInDocument,
      args: [null, selectionRect],
    });
    const value = results[0]?.result;
    return isCapturedPageSnapshot(value) ? await hashPageSnapshot(value) : null;
  } catch {
    return null;
  }
}

function isCapturedPageSnapshot(value: unknown): value is CapturedPageSnapshot {
  if (!isRecord(value)) return false;
  const documentMarker = value["documentMarker"];
  const url = value["url"];
  const viewportWidth = value["viewportWidth"];
  const viewportHeight = value["viewportHeight"];
  const devicePixelRatio = value["devicePixelRatio"];
  const scrollX = value["scrollX"];
  const scrollY = value["scrollY"];
  const selection = value["selection"];
  return (
    typeof documentMarker === "string" &&
    documentMarker.length > 0 &&
    typeof url === "string" &&
    /^https?:/iu.test(url) &&
    typeof viewportWidth === "number" &&
    Number.isSafeInteger(viewportWidth) &&
    viewportWidth > 0 &&
    typeof viewportHeight === "number" &&
    Number.isSafeInteger(viewportHeight) &&
    viewportHeight > 0 &&
    typeof devicePixelRatio === "number" &&
    Number.isFinite(devicePixelRatio) &&
    devicePixelRatio > 0 &&
    typeof scrollX === "number" &&
    Number.isFinite(scrollX) &&
    scrollX >= 0 &&
    typeof scrollY === "number" &&
    Number.isFinite(scrollY) &&
    scrollY >= 0 &&
    (selection === null || isSelectionFingerprint(selection))
  );
}

function isSelectionFingerprint(
  value: unknown,
): value is CapturedSelectionFingerprint {
  if (!isRecord(value)) return false;
  const url = value["url"];
  const tagName = value["tagName"];
  const rect = value["rect"];
  return (
    typeof url === "string" &&
    url.length > 0 &&
    typeof tagName === "string" &&
    tagName.length > 0 &&
    isSelectionRectFingerprint(rect)
  );
}

function isSelectionRectFingerprint(
  value: unknown,
): value is SelectionRectFingerprint {
  if (!isRecord(value)) return false;
  const x = value["x"];
  const y = value["y"];
  const width = value["width"];
  const height = value["height"];
  return (
    typeof x === "number" &&
    Number.isFinite(x) &&
    typeof y === "number" &&
    Number.isFinite(y) &&
    typeof width === "number" &&
    Number.isFinite(width) &&
    width > 0 &&
    typeof height === "number" &&
    Number.isFinite(height) &&
    height > 0
  );
}

function capturePageSnapshotInDocument(
  documentMarker: string | null,
  selectionRect: SelectionRectFingerprint,
): CapturedPageSnapshot {
  const resolveUrl = (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("data:") || trimmed.startsWith("blob:"))
      return trimmed;
    try {
      return new URL(trimmed, document.baseURI).toString();
    } catch {
      return null;
    }
  };
  const key = "__provenanceLensDocumentMarker";
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  if (documentMarker) target[key] = documentMarker;
  const storedMarker = target[key];
  const elementAtPoint = document.elementFromPoint(
    selectionRect.x + selectionRect.width / 2,
    selectionRect.y + selectionRect.height / 2,
  );
  const directCandidate =
    elementAtPoint instanceof HTMLImageElement ||
    elementAtPoint instanceof HTMLVideoElement
      ? elementAtPoint
      : null;
  const ancestorCandidate = elementAtPoint?.closest("img, picture, video");
  const candidate = directCandidate ?? ancestorCandidate ?? elementAtPoint;
  let candidateUrl: string | null = null;
  let tagName = "";
  let candidateElement: Element | null = null;
  if (candidate instanceof HTMLImageElement) {
    const raw =
      candidate.currentSrc ||
      candidate.getAttribute("src") ||
      candidate.getAttribute("data-src") ||
      candidate.getAttribute("data-lazy-src") ||
      candidate.getAttribute("data-original") ||
      candidate.getAttribute("data-url");
    candidateUrl = raw ? resolveUrl(raw) : null;
    tagName = candidate.closest("picture") ? "PICTURE" : "IMG";
    candidateElement = candidate;
  } else if (candidate instanceof HTMLPictureElement) {
    const image = candidate.querySelector("img");
    if (image) {
      const raw =
        image.currentSrc ||
        image.getAttribute("src") ||
        image.getAttribute("data-src") ||
        image.getAttribute("data-lazy-src") ||
        image.getAttribute("data-original") ||
        image.getAttribute("data-url");
      candidateUrl = raw ? resolveUrl(raw) : null;
      tagName = "PICTURE";
      candidateElement = image;
    }
  } else if (candidate instanceof HTMLVideoElement && candidate.poster) {
    candidateUrl = resolveUrl(candidate.poster);
    tagName = "VIDEO";
    candidateElement = candidate;
  } else if (candidate instanceof HTMLElement) {
    const background = getComputedStyle(candidate).backgroundImage;
    const match = /url\(\s*(["']?)(.*?)\1\s*\)/u.exec(background);
    candidateUrl = match?.[2] ? resolveUrl(match[2]) : null;
    tagName = "BACKGROUND";
    candidateElement = candidate;
  }
  let selection: CapturedSelectionFingerprint | null = null;
  if (candidateUrl && candidateElement) {
    const rect = candidateElement.getBoundingClientRect();
    selection = {
      url: candidateUrl,
      tagName,
      rect: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      },
    };
  }
  return {
    documentMarker: typeof storedMarker === "string" ? storedMarker : "",
    url: location.href,
    viewportWidth: Math.max(1, Math.round(window.innerWidth)),
    viewportHeight: Math.max(1, Math.round(window.innerHeight)),
    devicePixelRatio: Math.min(10, Math.max(1, window.devicePixelRatio || 1)),
    scrollX: Math.max(0, window.scrollX),
    scrollY: Math.max(0, window.scrollY),
    selection:
      selection && selection.rect.width > 0 && selection.rect.height > 0
        ? selection
        : null,
  };
}

async function hashPageSnapshot(
  snapshot: CapturedPageSnapshot,
): Promise<PageSnapshot> {
  return {
    documentMarker: snapshot.documentMarker,
    pageUrlSha256: await sha256Text(snapshot.url),
    viewportWidth: snapshot.viewportWidth,
    viewportHeight: snapshot.viewportHeight,
    devicePixelRatio: snapshot.devicePixelRatio,
    scrollX: snapshot.scrollX,
    scrollY: snapshot.scrollY,
    selection: snapshot.selection
      ? {
          sourceUrlSha256: await sha256Text(snapshot.selection.url),
          tagName: snapshot.selection.tagName,
          rect: snapshot.selection.rect,
        }
      : null,
  };
}

async function sha256Text(value: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(value));
}

async function handleDownloadFallback(resultId: string): Promise<void> {
  pruneFallbackImages();
  const fallback = fallbackImages.get(resultId);
  if (!fallback) {
    await notifyStandaloneError(
      "image_retrieval_failed",
      "The original image is no longer available for download.",
    );
    return;
  }
  try {
    const url = `data:${fallback.image.mime};base64,${toBase64(fallback.image.bytes)}`;
    await chrome.downloads.download({
      url,
      filename: fallback.image.filename,
      conflictAction: "uniquify",
      saveAs: true,
    });
    discardFallbackImage(resultId);
  } catch {
    await notifyStandaloneError(
      "permission_denied",
      "Grant optional download permission in Settings to save the selected image.",
      { tabId: fallback.tabId },
    );
  }
}

function pruneFallbackImages(): void {
  const cutoff = Date.now() - FALLBACK_IMAGE_TTL_MS;
  for (const [id, fallback] of fallbackImages) {
    if (fallback.createdAt < cutoff) discardFallbackImage(id);
  }
  const oldest = [...fallbackImages.entries()].sort(
    ([, left], [, right]) => left.createdAt - right.createdAt,
  );
  let totalBytes = [...fallbackImages.values()].reduce(
    (total, fallback) => total + fallback.image.bytes.byteLength,
    0,
  );
  while (
    oldest.length > 0 &&
    (fallbackImages.size > MAX_FALLBACK_IMAGES ||
      totalBytes > MAX_FALLBACK_TOTAL_BYTES)
  ) {
    const oldestEntry = oldest.shift();
    if (!oldestEntry) break;
    const [id, fallback] = oldestEntry;
    totalBytes -= fallback.image.bytes.byteLength;
    discardFallbackImage(id);
  }
}

function pruneScreenshotFallbacks(): void {
  for (const id of boundedExpiredIds(
    screenshotFallbacks.entries(),
    Date.now(),
    SCREENSHOT_FALLBACK_TTL_MS,
    MAX_SCREENSHOT_FALLBACKS,
  )) {
    discardScreenshotFallback(id);
  }
}

function discardScreenshotFallback(id: string): void {
  screenshotFallbacks.delete(id);
}

function discardFallbackImage(id: string): void {
  const fallback = fallbackImages.get(id);
  if (!fallback) return;
  fallback.image.bytes.fill(0);
  fallbackImages.delete(id);
}

function retainFallbackImage(
  resultId: string,
  image: RetrievedImage,
  tabId: number,
  windowId: number,
): void {
  fallbackImages.set(resultId, {
    image,
    tabId,
    windowId,
    createdAt: Date.now(),
  });
  pruneFallbackImages();
}

async function pruneFallbacksToStoredRecords(): Promise<void> {
  const [history, latest] = await Promise.all([
    getHistory(),
    getLatestRecord(),
  ]);
  const retainedIds = new Set(history.map((record) => record.id));
  if (latest) retainedIds.add(latest.id);
  for (const id of unretainedIds(fallbackImages.keys(), retainedIds)) {
    discardFallbackImage(id);
  }
  for (const id of unretainedIds(screenshotFallbacks.keys(), retainedIds)) {
    discardScreenshotFallback(id);
  }
}

async function hasImageHostPermission(
  tabId: number,
  url: URL,
  pageOrigin: string,
): Promise<boolean> {
  if (url.origin === pageOrigin) return true;
  try {
    return await chrome.permissions.contains({ origins: [originPattern(url)] });
  } catch {
    void tabId;
    return false;
  }
}

async function ensureContextMenu(): Promise<void> {
  const contextMenus = getContextMenusApi();
  if (!contextMenus) return;
  try {
    await contextMenus.remove(ACTION_ID);
  } catch {
    // The menu may not exist on the first installation.
  }
  contextMenus.create({
    id: ACTION_ID,
    title: "Check OpenAI provenance",
    contexts: ["image"],
  });
}

function getContextMenusApi(): typeof chrome.contextMenus | undefined {
  return chrome.contextMenus;
}

async function ensureTrustedStorageAccess(): Promise<void> {
  try {
    await chrome.storage.local.setAccessLevel({
      accessLevel: "TRUSTED_CONTEXTS",
    });
    await chrome.storage.session.setAccessLevel({
      accessLevel: "TRUSTED_CONTEXTS",
    });
  } catch {
    // Older Chromium builds may not expose the access-level API.
  }
}

async function setWorkflow(
  status: "idle" | "picking" | "retrieving" | "verifying" | "error",
  message: string,
  actionId: ActionId = ACTION_ID,
): Promise<void> {
  await setWorkflowState({
    status,
    actionId: status === "idle" ? null : actionId,
    message: sanitizeDisplayText(message, 512),
    updatedAt: new Date().toISOString(),
  });
}

async function setBadge(tabId: number, text: string): Promise<void> {
  const existing = badgeTimers.get(tabId);
  if (existing) clearTimeout(existing);
  await chrome.action.setBadgeText({ tabId, text });
  if (text === "…" || text === "") return;
  const timer = setTimeout(() => {
    void chrome.action.setBadgeText({ tabId, text: "" });
    badgeTimers.delete(tabId);
  }, 45_000);
  badgeTimers.set(tabId, timer);
}

async function clearBadge(tabId?: number): Promise<void> {
  if (tabId !== undefined) {
    await chrome.action.setBadgeText({ tabId, text: "" });
    const timer = badgeTimers.get(tabId);
    if (timer) clearTimeout(timer);
    badgeTimers.delete(tabId);
    return;
  }
  await chrome.action.setBadgeText({ text: "" });
  for (const timer of badgeTimers.values()) clearTimeout(timer);
  badgeTimers.clear();
}

async function cancelActiveVerification(
  senderTabId: number | undefined,
): Promise<void> {
  let focusedTabId: number | undefined;
  try {
    const tabs = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    focusedTabId = tabs[0]?.id;
  } catch {
    focusedTabId = undefined;
  }
  const tabId = resolveCancellationTabId(
    senderTabId,
    activeVerifications.tabIds(),
    focusedTabId,
  );
  if (tabId === undefined) return;
  activeVerifications.abort(tabId, USER_CANCELLED_REASON);
}

async function notifyDetectedResult(
  resultId: string,
  result: VerificationOutcome["result"],
  pageTarget: PageTarget | null,
): Promise<void> {
  const copy = detectedToastCopy(result);
  await showPageToast(pageTarget, {
    tone: "detected",
    title: copy.title,
    message: copy.message,
    resultId,
  });
}

async function notifyNoSignalResult(
  resultId: string,
  pageTarget: PageTarget | null,
): Promise<void> {
  const copy = noSignalToastCopy();
  await showPageToast(pageTarget, {
    tone: "no-signal",
    title: copy.title,
    message: copy.message,
    resultId,
  });
}

async function notifyErrorResult(
  resultId: string,
  reason: string,
  pageTarget: PageTarget | null,
): Promise<void> {
  const safeReason =
    sanitizeDisplayText(reason, 180) || "The image could not be verified.";
  const copy = errorToastCopy(safeReason);
  await showPageToast(pageTarget, {
    tone: "error",
    title: copy.title,
    message: copy.message,
    resultId,
  });
}

async function notifyStandaloneError(
  code: ErrorCode,
  reason: string,
  options: { pageTarget?: PageTarget | null; tabId?: number } = {},
): Promise<void> {
  await setWorkflow("error", reason);
  if (options.tabId !== undefined) {
    await setBadge(options.tabId, "!").catch(() => undefined);
  }
  const safeReason =
    sanitizeDisplayText(reason, 220) || "The image could not be verified.";
  await showPageToast(options.pageTarget ?? null, {
    tone: "error",
    title:
      code === "protected_page"
        ? "Unsupported browser page"
        : "Verification failed",
    message: safeReason,
    resultId: null,
  });
}

async function showPageToast(
  pageTarget: PageTarget | null,
  toast: PageToast,
): Promise<void> {
  if (!pageTarget) return;
  const message: ShowToastMessage = {
    type: "show-toast",
    runtimeVersion: PICKER_RUNTIME_VERSION,
    sessionToken: pageTarget.sessionToken,
    tone: toast.tone,
    title: sanitizeDisplayText(toast.title, 100),
    message: sanitizeDisplayText(toast.message, 512),
    resultId: toast.resultId,
  };
  const binding = toast.resultId
    ? { ...pageTarget, resultId: toast.resultId }
    : null;
  if (binding) {
    try {
      await rememberResultToastBinding(binding);
    } catch {
      return;
    }
  } else {
    await forgetPageResultToastBindings(pageTarget).catch(() => undefined);
  }
  try {
    await chrome.tabs.sendMessage(pageTarget.tabId, message, {
      documentId: pageTarget.documentId,
    });
  } catch {
    if (binding) await forgetResultToastBinding(binding).catch(() => undefined);
  }
}

async function readResultToastBindings(): Promise<ResultToastBinding[]> {
  const values = await chrome.storage.session.get(RESULT_TOAST_BINDINGS_KEY);
  const parsed = ResultToastBindingsSchema.safeParse(
    values[RESULT_TOAST_BINDINGS_KEY],
  );
  return parsed.success ? parsed.data : [];
}

async function mutateResultToastBindings(
  update: (bindings: ResultToastBinding[]) => ResultToastBinding[],
): Promise<void> {
  const operation = resultToastBindingMutation.then(async () => {
    const bindings = await readResultToastBindings();
    const next = ResultToastBindingsSchema.parse(update(bindings));
    await chrome.storage.session.set({ [RESULT_TOAST_BINDINGS_KEY]: next });
  });
  resultToastBindingMutation = operation.catch(() => undefined);
  await operation;
}

async function getResultToastBinding(
  sessionToken: string,
): Promise<ResultToastBinding | null> {
  await resultToastBindingMutation;
  return (
    (await readResultToastBindings()).find(
      (binding) => binding.sessionToken === sessionToken,
    ) ?? null
  );
}

async function rememberResultToastBinding(
  binding: ResultToastBinding,
): Promise<void> {
  await mutateResultToastBindings((bindings) =>
    upsertResultToastBinding(bindings, binding, MAX_RESULT_TOAST_BINDINGS),
  );
}

async function forgetResultToastBinding(
  binding: ResultToastBinding,
): Promise<void> {
  await mutateResultToastBindings((bindings) =>
    removeResultToastBinding(bindings, binding),
  );
}

async function forgetPageResultToastBindings(
  pageTarget: PageTarget,
): Promise<void> {
  await mutateResultToastBindings((bindings) =>
    removePageResultToastBindings(bindings, pageTarget),
  );
}

async function openResultDetails(
  message: Extract<ExtensionMessage, { type: "open-result-details" }>,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const binding = await getResultToastBinding(message.sessionToken).catch(
    () => null,
  );
  if (
    !binding ||
    !matchesResultToastBinding(binding, message, {
      tabId: sender.tab?.id,
      frameId: sender.frameId,
      documentId: sender.documentId,
    })
  ) {
    return;
  }
  const result = await getResult(message.resultId);
  if (!result) return;
  const current = await getResultToastBinding(message.sessionToken).catch(
    () => null,
  );
  if (!current || !sameResultToastBinding(current, binding)) return;
  try {
    await forgetResultToastBinding(binding);
  } catch {
    return;
  }
  await chrome.tabs.create({
    url: resultDetailsUrl(
      chrome.runtime.getURL("details.html"),
      message.resultId,
    ),
  });
  await clearBadge(binding.tabId);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(index, Math.min(index + chunkSize, bytes.length)),
    );
  }
  return btoa(binary);
}
