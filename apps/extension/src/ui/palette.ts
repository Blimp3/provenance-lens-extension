import {
  AUDIO_ACTION_ID,
  DOWNLOAD_ACTION_ID,
  PICK_VIDEO_ACTION_ID,
  type ActivityEntry,
  type DisclosureMode,
  type ExtensionMessage,
  type HistoryRecord,
  type LinkDownloadOptions,
  type WorkflowState,
} from "@provenance-lens/shared";

import { RECENT_LIMIT, recentRow } from "../activity.js";
import {
  createPairing,
  getPendingPairing,
  isIntegrationConnected,
} from "../integration-client.js";
import {
  isOwnPalettePort,
  type PaletteHostAnswer,
  type PaletteHostCheck,
  type PaletteHostClose,
} from "../palette-host.js";
import {
  defaultSettings,
  getActivity,
  getHistory,
  getSettings,
  getWorkflowState,
} from "../storage.js";
import {
  getOptionalAccessState,
  type OptionalAccessState,
} from "./optional-access.js";
import {
  ALIAS_RULE,
  checkAlias,
  commandGate,
  DECLARED_COMMAND_IDS,
  effectiveAliases,
  fitsAudioCheck,
  formatClock,
  formatDuration,
  isDeclaredCommand,
  matchScore,
  MEDIA_PICK_MESSAGE,
  nextTabStop,
  PALETTE_COMMANDS,
  PALETTE_OPEN_KEY,
  PALETTE_PREFS_KEY,
  paletteCommand,
  paletteKey,
  parseClockRange,
  parsePaletteOpenRecord,
  parsePalettePrefs,
  rankRows,
  shortcutKeys,
  withAlias,
  withLastUsed,
  type CommandRun,
  type IconName,
  type PaletteCommand,
  type PaletteContext,
  type PaletteOpenRecord,
  type PalettePrefs,
  type PaletteView,
  type TabPage,
} from "./palette-commands.js";
import {
  choicesFor,
  clearSavedCache,
  clearSavedHistory,
  CONNECT_CONSENT,
  CONNECT_INTRO,
  confirmFor,
  COPY_HINT_MAC,
  COPY_HINT_OTHER,
  copyText,
  defaultFor,
  disconnectDigiBot,
  finishSetupItems,
  flipSetting,
  formatPairingCode,
  MODE_DISCLOSURES,
  openTabPage,
  PAIR_INSTRUCTION,
  PAIRING_TEXT,
  pairingStartedAt,
  pickPaletteSettings,
  pollPairing,
  PROVIDER_DETAILS_URL,
  RESULT_MEANINGS,
  saveSetting,
  settingsItems,
  type ChoiceView,
  type ConfirmView,
  type Outcome,
  type PairingPoll,
  type PaletteSettings,
  type SettingKey,
  type SettingsItem,
  type SettingsRun,
  type SettingUpdate,
} from "./palette-settings.js";

/**
 * The Lens palette frame. Inside a page it renders only with the single-use
 * token the worker stored for it; anywhere else it stays blank and sends
 * nothing. Opening it reads local storage only.
 */

type HostKind = PaletteContext["host"];
type Row = {
  group: string;
  title: string;
  subtitle: string;
  warn?: boolean;
  icon?: IconName;
  dot?: "ok" | "neutral" | "danger";
  value?: string;
  alias?: string;
  keys?: readonly string[];
  trailing?: "›" | "↗";
  note?: string;
  digit?: number;
  verb: string;
  commandId?: string;
  record?: HistoryRecord;
  /** The value setting ⌘K › Reset to default restores. */
  setting?: SettingKey;
  /** A Choice row's current value: an accent check. */
  check?: boolean;
  /** A Confirm view's danger action. */
  danger?: boolean;
  run?: () => void | Promise<void>;
};
type ActionItem = {
  title: string;
  keys?: readonly string[];
  run: () => void | Promise<void>;
};
type Hint = { text: string; error: boolean };
type InputSource = "key" | "pointer";
/** Text above a Detail or Confirm view's rows, outside the listbox. */
type Detail = {
  heading?: string;
  status?: Hint;
  pair?: { command: string; code: string };
  paragraphs: readonly string[];
};
type BuiltView = {
  rows: Row[];
  hint?: Hint;
  notes?: string[];
  empty?: string;
  detail?: Detail;
};
type PendingPairing = {
  pairId: string;
  confirmationCode: string;
  expiresAt: string;
};
type FrameData = {
  context: PaletteContext;
  prefs: PalettePrefs;
  shortcuts: ReadonlyMap<string, string>;
  workflow: WorkflowState | null;
  history: readonly HistoryRecord[];
  activity: readonly ActivityEntry[];
  /** Only the settings the palette shows: never the backend or its token. */
  settings: PaletteSettings;
  pending: PendingPairing | null;
  optionalAccess: OptionalAccessState | null;
};

/** A job or footer message older than this is stale. */
const FRESH_MS = 120_000;
const SAVED_NOTE_MS = 2_500;
const RUNNING: ReadonlySet<WorkflowState["status"]> = new Set([
  "picking",
  "retrieving",
  "verifying",
  "sending",
]);
const IS_MAC = /Mac/u.test(navigator.userAgent);
const COPY_HINT = IS_MAC ? COPY_HINT_MAC : COPY_HINT_OTHER;
const VIEW_LABELS: Readonly<Record<PaletteView, string>> = {
  root: "",
  download: "Download",
  verify: "Verify",
  clip: "Clip",
  recent: "Recent",
  "audio-range": "Verify › Audio of this page",
  alias: "Set alias",
  settings: "Settings",
  connect: "Settings › DigiBot",
  disconnect: "Settings › DigiBot",
  "verification-mode": "Settings › Verification mode",
  "history-retention": "Settings › Keep history",
  "cache-limit": "Settings › Local cache",
  "clear-history": "Settings › Clear history",
  "clear-cache": "Settings › Clear verification cache",
  "command-hotkeys": "Settings › Command hotkeys",
  aliases: "Settings › Aliases",
  "reset-aliases": "Settings › Reset aliases",
  "about-results": "Settings › What a result means",
  disclosure: "Disclosure",
};
/** Views whose input is a field, not a search. */
const FORM_VIEWS: ReadonlySet<PaletteView> = new Set([
  "clip",
  "audio-range",
  "alias",
]);
/** Views the worker opens with Settings one step back. */
const UNDER_SETTINGS: ReadonlySet<PaletteView> = new Set([
  "connect",
  "verification-mode",
]);
/** The Settings views a toast's button can open the palette at. */
const SETTINGS_OPENS: ReadonlySet<PaletteView> = new Set([
  "settings",
  ...UNDER_SETTINGS,
]);
const RUN_VERBS: Readonly<Record<SettingsRun["kind"], string>> = {
  view: "Open",
  toggle: "Toggle",
  tab: "Open",
  none: "Open",
};
const LIMITS =
  "Image API checks also verify embedded Content Credentials on the backend. Audio checks look for supported OpenAI SynthID signals. Finding no supported signal does not establish human origin; these checks are not universal AI detectors.";
/** The Disclosure view's text, as the Disclosure page had it before 2.1.0. */
const DISCLOSURES: Readonly<
  Record<DisclosureMode, { heading: string; paragraphs: readonly string[] }>
> = {
  website: {
    heading: "Before your first verification",
    paragraphs: [
      "Website mode downloads the exact bytes Lens retrieved for the selected image and opens OpenAI Verify. You choose the downloaded file and review the result on OpenAI's website. Your browser saves the file and may retain a record in its download history.",
      "Provenance Lens does not upload the file to OpenAI, automate or scrape the Verify page, read its result, or add a website result to extension history or cache.",
    ],
  },
  api: {
    heading: "Before your first verification",
    paragraphs: [
      "API mode uploads the exact bytes of the selected image or audio file to your configured verification server, which sends them to the documented OpenAI Content Provenance API. The backend and a valid OpenAI API key are required; the key remains on the backend and is never stored in this extension.",
      "Successful API verdicts may be stored in the separate authenticated server cache and bounded local cache. Media bytes and source URLs are not stored in either cache or in result history.",
    ],
  },
  synthid: {
    heading: "Before you check with Google SynthID",
    paragraphs: [
      "Google has no SynthID API yet, so this handoff saves the exact bytes Lens retrieved for the selected image and opens Google's SynthID Detector in a new tab. You upload the file there yourself, signed in to Google, under Google's terms. Your browser keeps the copy in its download folder and may retain a record in its download history.",
      "Google's site says that Google keeps a signature of each uploaded file for 24 hours. Provenance Lens does not upload the file to Google, automate or read the SynthID Detector page, or add the handoff to extension history or cache.",
    ],
  },
};
const LENS_ROWS = [
  "view-download",
  "view-verify",
  "view-clip",
  "view-recent",
  "view-settings",
] as const;
const AUDIO_RANGE_MESSAGE = "An audio check covers 1 to 60 seconds.";
const COVERED_MESSAGE =
  "The page is covering Lens. Press Esc and open it again.";
/** How long the panel must have been visible before a key runs a row. */
const KEY_VISIBLE_MS = 250;
/** How long the panel must have been visible before a click runs a row. */
const POINTER_VISIBLE_MS = 500;
/** A key pressed this soon after the frame is ready may wait for the panel. */
const EARLY_KEY_MS = 1_000;
/** How long the host has to answer before a run; no answer runs nothing. */
const HOST_CHECK_MS = 500;
/** How often the frame asks its host on its own timer, between answers. */
const HOST_WATCH_MS = 100;
/** How long that question may wait before the frame closes the palette. */
const HOST_WATCH_LIMIT_MS = 2_000;
/** The panel is observed afresh after this long, plus up to as long again. */
const RESAMPLE_MS = 40;

const paletteRoot = required<HTMLElement>("palette");
const panelElement = required<HTMLElement>("panel");
const scrim = required<HTMLElement>("scrim");
const backButton = required<HTMLButtonElement>("back");
const chip = required<HTMLButtonElement>("chip");
const input = required<HTMLInputElement>("query");
const accessory = required<HTMLElement>("accessory");
const spinner = required<HTMLElement>("spinner");
const hintElement = required<HTMLElement>("hint");
const detailElement = required<HTMLElement>("detail");
const list = required<HTMLElement>("list");
const live = required<HTMLElement>("live");
const statusDot = required<HTMLElement>("status-dot");
const statusText = required<HTMLElement>("status-text");
const footerBack = required<HTMLElement>("footer-back");
const footerVerb = required<HTMLElement>("footer-verb-text");
const actionsButton = required<HTMLButtonElement>("actions-button");
const actionsPanel = required<HTMLElement>("actions");
const actionsInput = required<HTMLInputElement>("actions-query");
const actionsList = required<HTMLElement>("actions-list");

const params = new URLSearchParams(location.hash.slice(1));
const token = params.get("t");
const embedded = window.top !== window;
const hostKind: HostKind = embedded
  ? "page"
  : new URLSearchParams(location.search).get("host") === "popup"
    ? "popup"
    : "tab";

let record: PaletteOpenRecord | null = null;
/** This frame's own host port, held for as long as the frame lives. */
let ownPort: chrome.runtime.Port | null = null;
let data: FrameData | null = null;
let stack: PaletteView[] = ["root"];
let aliasTarget: string | null = null;
let rows: Row[] = [];
let active = 0;
let actionsOpen = false;
let actionItems: ActionItem[] = [];
let shownActions: ActionItem[] = [];
let actionActive = 0;
let savedUntil = 0;
let savedText = "Saved";
let footerError: string | null = null;
/** A setting's result message, in the hint row until the next view or input. */
let notice: Hint | null = null;
/** The Connect view's status while it creates, times out or disconnects. */
let connectStatus: Hint | null = null;
/** The pairing this frame asks DigiBot about; it ends with the frame. */
let pairingPoll: PairingPoll | null = null;
/** A pairing request is being created; no pairing starts or resumes. */
let creatingPairing = false;
/** The /link copy fell back to a selection for a keyboard copy. */
let copySelected = false;
/** The Detail on screen, so a render that changes nothing keeps a selection. */
let detailKey = "";
/** The panel's latest IntersectionObserver v2 visibility; none yet is hidden. */
let panelVisible = false;
let panelVisibleSince = 0;
/** The frame's size when the visible clock last restarted. */
let clockSize = "";
/** When the frame told its host it was ready; 0 until then. */
let readyAt = 0;
/** When the frame first rendered its view. */
let renderedAt = 0;
/** The stored settings could not be read; the palette shows the defaults. */
let settingsUnavailable = false;
/** Whether the panel was reported hidden since the frame was ready. */
let hiddenSinceReady = false;
/** The latest early key, waiting until the panel has been visible long enough. */
let heldRun: (() => Promise<void>) | null = null;
let heldTimer: ReturnType<typeof setTimeout> | undefined;
/** Keys down in this frame, by code; the host stops their keyups on close. */
const heldKeys = new Set<string>();

void start();

async function start(): Promise<void> {
  record = await takeOpenRecord();
  // A frame, popup or tab without its own single-use token stays blank.
  if (!record) return;
  if (embedded && token) {
    // Every live frame sees every host's port; only this frame's is kept,
    // and another palette's port is left alone.
    chrome.runtime.onConnect.addListener((port) => {
      if (!isOwnPalettePort(port, token)) return;
      ownPort = port;
      port.onDisconnect.addListener(() => {
        if (ownPort === port) ownPort = null;
      });
      watchHost(port);
    });
  }
  document.documentElement.classList.add(`host-${hostKind}`);
  const view = record?.view ?? "root";
  // The Disclosure view has nothing to go back to: Esc cancels it.
  stack =
    view === "root" || view === "disclosure"
      ? [view]
      : UNDER_SETTINGS.has(view)
        ? ["root", "settings", view]
        : ["root", view];
  data = await loadData();
  wireEvents();
  paletteRoot.hidden = false;
  if (embedded) watchPanelVisibility();
  render();
  renderedAt = performance.now();
  input.focus();
  if (embedded) {
    readyAt = performance.now();
    window.parent.postMessage({ lens: "ready" }, parentOrigin());
    setTimeout(dropHeld, EARLY_KEY_MS);
  }
}

async function takeOpenRecord(): Promise<PaletteOpenRecord | null> {
  if (!token) return null;
  try {
    const values = await chrome.storage.session.get(PALETTE_OPEN_KEY);
    const stored = parsePaletteOpenRecord(values[PALETTE_OPEN_KEY]);
    if (!stored || stored.token !== token || stored.host !== hostKind)
      return null;
    // Single use: a replayed or copied token finds nothing.
    await chrome.storage.session.remove(PALETTE_OPEN_KEY);
    return stored;
  } catch {
    return null;
  }
}

async function loadData(): Promise<FrameData> {
  const [
    connected,
    settings,
    downloadAccess,
    workflow,
    history,
    activity,
    prefs,
    commands,
    pending,
    optionalAccess,
  ] = await Promise.all([
    isIntegrationConnected().catch(() => false),
    getSettings()
      .then(pickPaletteSettings)
      .catch(() => {
        settingsUnavailable = true;
        return pickPaletteSettings(defaultSettings);
      }),
    chrome.permissions
      .contains({ permissions: ["downloads"] })
      .catch(() => false),
    getWorkflowState().catch(() => null),
    getHistory().catch(() => [] as HistoryRecord[]),
    getActivity().catch(() => [] as ActivityEntry[]),
    chrome.storage.local
      .get(PALETTE_PREFS_KEY)
      .then((values) => values[PALETTE_PREFS_KEY])
      .catch(() => undefined),
    chrome.commands.getAll().catch(() => [] as chrome.commands.Command[]),
    getPendingPairing().catch(() => null),
    getOptionalAccessState().catch(() => null),
  ]);
  const shortcuts = new Map<string, string>();
  for (const entry of commands)
    if (entry.name) shortcuts.set(entry.name, entry.shortcut ?? "");
  return {
    context: {
      host: hostKind,
      page: record?.page ?? "none",
      hostname: record?.hostname ?? "",
      scope: record?.scope ?? "page",
      needsPick: record?.needsPick ?? false,
      connected,
      downloadAccess,
      verifyMode: verifyModeText(connected, settings),
      range: null,
    },
    prefs: parsePalettePrefs(prefs),
    shortcuts,
    workflow,
    history,
    activity,
    settings,
    pending: pending
      ? {
          pairId: pending.pairId,
          confirmationCode: pending.confirmationCode,
          expiresAt: pending.expiresAt,
        }
      : null,
    optionalAccess,
  };
}

function verifyModeText(connected: boolean, settings: PaletteSettings): string {
  return connected
    ? "DigiBot check"
    : settings.verificationMode === "api"
      ? "API check"
      : "OpenAI Verify site";
}

async function reload(): Promise<void> {
  data = await loadData();
  render();
}

function wireEvents(): void {
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener(
    "keyup",
    (event) => heldKeys.delete(event.code),
    true,
  );
  window.addEventListener("blur", () => heldKeys.clear());
  // A frame inside a page cannot focus its input until the host focuses the
  // frame, so the input takes focus each time the frame gets it.
  window.addEventListener("focus", () => {
    const focused = document.activeElement;
    if (focused === null || focused === document.body)
      (actionsOpen ? actionsInput : input).focus();
  });
  // A key still waiting was for the query as it was.
  input.addEventListener("input", () => {
    active = 0;
    footerError = null;
    notice = null;
    clearHeld();
    render();
  });
  actionsInput.addEventListener("input", () => {
    actionActive = 0;
    clearHeld();
    renderActions();
  });
  scrim.addEventListener("click", () => close());
  backButton.addEventListener("click", () => back());
  chip.addEventListener("click", () => back());
  actionsButton.addEventListener("click", () => toggleActions());
  chrome.storage.onChanged.addListener((_changes, areaName) => {
    if (areaName !== "local" && areaName !== "session") return;
    void reload();
  });
  chrome.permissions.onAdded.addListener(() => void reload());
  chrome.permissions.onRemoved.addListener(() => void reload());
}

/**
 * A page can lay its own top-layer element over the host while clicks and
 * keys still reach the frame. IntersectionObserver v2 reports the panel
 * visible only when nothing covers it and no opacity, filter or transform
 * other than a 2D translation applies to it, the frame or the host, so input
 * runs only once it has been visible for a moment. The host closes the
 * palette when the page moves or restyles it, which IntersectionObserver v2
 * would not always see. A page that only hides the host while it paints and
 * shows it again before any timer or port message changes no attribute, so
 * neither the host's mutation observer nor its answers see it; this gate is
 * the only one for that case, and the hide-while-painting e2e fails if a
 * Chromium change stops it from reporting the panel hidden.
 */
function watchPanelVisibility(): void {
  const panel = required<HTMLElement>("panel");
  let recheck: ReturnType<typeof setTimeout> | undefined;
  const observer = new IntersectionObserver(
    (entries) => {
      const entry = entries.at(-1) as
        (IntersectionObserverEntry & { isVisible?: boolean }) | undefined;
      if (!entry) return;
      const visible = entry.isVisible === true;
      const shown = visible && !panelVisible;
      if (shown) restartVisibleClock();
      panelVisible = visible;
      paletteRoot.dataset["visible"] = String(visible);
      if (visible) {
        // Only a panel that was hidden clears the footer: a fresh sample of
        // a panel still visible must not drop the reason an early click
        // gave.
        if (shown) clearCovered();
        runHeldWhenAllowed();
      } else {
        if (readyAt > 0) hiddenSinceReady = true;
        dropHeld();
      }
      // The observer samples at most every 100 ms, so a page that lifts a
      // cover for a moment every 100 ms can keep each sample in a lifted
      // moment, and Chromium may keep reporting a frame hidden after the
      // host hid and showed it again (a fullscreen change, a closed dialog).
      // The panel is therefore observed afresh at random moments, visible
      // or not, which no page can keep in step with.
      clearTimeout(recheck);
      recheck = setTimeout(
        () => {
          observer.unobserve(panel);
          observer.observe(panel);
        },
        RESAMPLE_MS + Math.random() * RESAMPLE_MS,
      );
    },
    // trackVisibility and delay are IntersectionObserver v2 (Chromium).
    { trackVisibility: true, delay: 100 } as IntersectionObserverInit,
  );
  observer.observe(panel);
  // IntersectionObserver v2 does not count a zoom on the page as a
  // transform, but the zoom resizes the frame and moves the rows under a
  // resting pointer, so each resize restarts the visible clock.
  window.addEventListener("resize", () => {
    restartVisibleClock();
    runHeldWhenAllowed();
  });
}

function frameSize(): string {
  return `${innerWidth}x${innerHeight}`;
}

function restartVisibleClock(): void {
  clockSize = frameSize();
  panelVisibleSince = performance.now();
}

/**
 * Whether input may run now: in a page, a key once the panel has been
 * visible for 250 ms and a click once it has been visible for 500 ms, with
 * no hidden report in between. The popup and the tab are extension pages no
 * website can cover.
 */
function inputAllowed(source: InputSource): boolean {
  if (!embedded) return true;
  // The resize event waits for the frame's next rendering, but a click can
  // land on the rows a zoom moved before it, so the size is checked here too.
  if (frameSize() !== clockSize) restartVisibleClock();
  const visibleFor = source === "key" ? KEY_VISIBLE_MS : POINTER_VISIBLE_MS;
  return panelVisible && performance.now() - panelVisibleSince >= visibleFor;
}

/**
 * Runs a row or an action for a key or a click that inputAllowed lets
 * through. A key pressed in the frame's first second, while the panel has
 * not been reported hidden, waits until the panel has been visible long
 * enough; only the latest such key waits. A page can click a toast's button
 * through its own overlay and open the palette at a Settings view, so an
 * early key there is dropped instead. Any other refused input is dropped,
 * and the footer says why.
 */
function gated(source: InputSource, run: () => Promise<void>): void {
  // In every host, a key the Disclosure view did not show for long enough
  // was meant for something else: it never acknowledges.
  if (
    source === "key" &&
    currentView() === "disclosure" &&
    performance.now() - renderedAt < KEY_VISIBLE_MS
  )
    return;
  if (inputAllowed(source)) {
    clearHeld();
    clearCovered();
    runChecked(run);
    return;
  }
  if (
    source === "key" &&
    readyAt > 0 &&
    !hiddenSinceReady &&
    !SETTINGS_OPENS.has(record?.view ?? "root") &&
    // An acknowledgement needs a key pressed after the view is visible.
    record?.view !== "disclosure" &&
    performance.now() - readyAt < EARLY_KEY_MS
  ) {
    heldRun = run;
    runHeldWhenAllowed();
    return;
  }
  showCovered();
}

function runHeldWhenAllowed(): void {
  clearTimeout(heldTimer);
  if (!heldRun || !panelVisible) return;
  const wait = panelVisibleSince + KEY_VISIBLE_MS - performance.now();
  heldTimer = setTimeout(
    () => {
      const run = heldRun;
      if (!run) return;
      // A timer may fire a fraction of a millisecond early.
      if (!inputAllowed("key")) {
        runHeldWhenAllowed();
        return;
      }
      heldRun = null;
      clearCovered();
      runChecked(run);
    },
    Math.max(0, Math.ceil(wait)),
  );
}

/**
 * Runs input the gate let through once the host answers over this frame's
 * own port that it still stands as it mounted: in the top layer, in its
 * parent, with its own inline style. A page can stop the host's events but
 * not this answer, and with no port or no answer in time nothing runs. The
 * popup and the tab run at once.
 */
function runChecked(run: () => Promise<void>): void {
  if (!embedded) {
    void run();
    return;
  }
  void hostIntact().then((intact) => {
    if (intact && panelVisible) void run();
    else showCovered();
  });
}

/**
 * Asks the host on the frame's own timer, which the page cannot clear,
 * whether it still stands as it mounted. A host that says no closes itself;
 * one that does not answer in time is asked to close.
 */
function watchHost(port: chrome.runtime.Port): void {
  const ask = (): void => {
    if (ownPort !== port) return;
    void hostIntact(HOST_WATCH_LIMIT_MS).then((intact) => {
      if (ownPort !== port) return;
      if (intact) {
        setTimeout(ask, HOST_WATCH_MS);
        return;
      }
      showCovered();
      close();
    });
  };
  setTimeout(ask, HOST_WATCH_MS);
}

function hostIntact(limitMs = HOST_CHECK_MS): Promise<boolean> {
  const port = ownPort;
  if (!port) return Promise.resolve(false);
  const nonce = crypto.randomUUID();
  return new Promise((resolve) => {
    const done = (intact: boolean): void => {
      clearTimeout(timer);
      port.onMessage.removeListener(onAnswer);
      port.onDisconnect.removeListener(onGone);
      resolve(intact);
    };
    const onAnswer = (message: unknown): void => {
      const answer = message as Partial<PaletteHostAnswer> | null;
      if (answer?.lens === "intact" && answer.nonce === nonce)
        done(answer.intact === true);
    };
    const onGone = (): void => done(false);
    const timer = setTimeout(() => done(false), limitMs);
    port.onMessage.addListener(onAnswer);
    port.onDisconnect.addListener(onGone);
    try {
      port.postMessage({ lens: "check", nonce } satisfies PaletteHostCheck);
    } catch {
      done(false);
    }
  });
}

/** A waiting key the panel hid from, or that waited a second, is dropped. */
function dropHeld(): void {
  if (!heldRun) return;
  clearHeld();
  showCovered();
}

function clearHeld(): void {
  clearTimeout(heldTimer);
  heldRun = null;
}

function showCovered(): void {
  footerError = COVERED_MESSAGE;
  renderFooter();
}

function clearCovered(): void {
  if (footerError !== COVERED_MESSAGE) return;
  footerError = null;
  renderFooter();
}

// Views ----------------------------------------------------------------------

function currentView(): PaletteView {
  return stack[stack.length - 1] ?? "root";
}

function context(range: PaletteContext["range"] = null): PaletteContext {
  if (!data) throw new Error("The palette has no data yet.");
  return { ...data.context, range };
}

function buildView(view: PaletteView): BuiltView {
  switch (view) {
    case "root":
      return input.value.trim() ? searchView(input.value) : rootView();
    case "download":
      return filtered(downloadRows());
    case "verify":
      return filtered(verifyRows());
    case "clip":
      return clipView();
    case "audio-range":
      return audioRangeView();
    case "recent":
      return recentView();
    case "alias":
      return aliasView();
    case "settings":
      return filtered(settingsRows());
    case "verification-mode":
    case "history-retention":
    case "cache-limit":
      return choiceView(view);
    case "disconnect":
    case "clear-history":
    case "clear-cache":
    case "reset-aliases":
      return confirmView(view);
    case "connect":
      return connectView();
    case "command-hotkeys":
      return filtered(hotkeyRows());
    case "aliases":
      return filtered(aliasRows());
    case "about-results":
      return {
        rows: [],
        detail: { heading: "What a result means", paragraphs: RESULT_MEANINGS },
      };
    case "disclosure":
      return disclosureView();
  }
}

/**
 * The one-time acknowledgement before a verification mode's first use, or
 * before the first SynthID handoff. Closing the palette without it cancels
 * the action (the worker watches the in-page palette's port).
 */
function disclosureView(): BuiltView {
  const pending = record?.disclosure;
  if (!pending) return { rows: [], empty: "This disclosure is invalid." };
  const cancel: Row = {
    group: "Disclosure",
    title: "Cancel",
    subtitle: "",
    icon: "x",
    verb: "Run",
    run: cancelDisclosure,
  };
  // Without the stored mode, the right text is unknown: nothing to acknowledge.
  if (!pending.synthId && settingsUnavailable)
    return numbered({
      rows: [cancel],
      detail: {
        heading: DISCLOSURES.website.heading,
        status: {
          text: "The verification mode could not be loaded. Cancel and try again.",
          error: true,
        },
        paragraphs: [],
      },
    });
  const mode: DisclosureMode = pending.synthId
    ? "synthid"
    : (data?.settings.verificationMode ?? "website");
  const { heading, paragraphs } = DISCLOSURES[mode];
  return numbered({
    rows: [
      {
        group: "Disclosure",
        title: "Acknowledge and pick an image",
        subtitle: "",
        icon: "shield-check",
        verb: "Run",
        run: () =>
          sendThenClose({
            type: "resume-permission",
            pendingId: pending.pendingId,
            verificationMode: mode,
          }),
      },
      cancel,
    ],
    detail: {
      heading,
      paragraphs: mode === "synthid" ? paragraphs : [...paragraphs, LIMITS],
    },
  });
}

/** Cancel, or Esc on the Disclosure view: the worker ends the action. */
async function cancelDisclosure(): Promise<void> {
  const pendingId = record?.disclosure?.pendingId;
  if (pendingId) await sendThenClose({ type: "cancel-disclosure", pendingId });
  else close();
}

function rootView(): BuiltView {
  const prefs = data?.prefs ?? { aliases: {}, lastUsed: [] };
  const built: Row[] = [...nowRows(), ...setupRows()];
  LENS_ROWS.forEach((id, index) => {
    const entry = paletteCommand(id);
    if (entry) built.push({ ...commandRow(entry, "Lens"), digit: index + 1 });
  });
  prefs.lastUsed.forEach((id, index) => {
    const entry = paletteCommand(id);
    if (!entry) return;
    const row = commandRow(entry, "Last used");
    built.push({
      ...row,
      subtitle: row.warn ? row.subtitle : entry.path,
      digit: 6 + index,
    });
  });
  return { rows: built };
}

function searchView(query: string): BuiltView {
  const prefs = data?.prefs ?? { aliases: {}, lastUsed: [] };
  const aliases = effectiveAliases(prefs);
  const running = runningVerification();
  const commands = PALETTE_COMMANDS.filter(
    (entry) =>
      !(entry.run.kind === "start" && entry.run.range) &&
      (entry.id !== "cancel-active" || running),
  ).map((entry) => {
    const alias = aliases[entry.id];
    return {
      id: entry.id,
      title: entry.title,
      entry,
      ...(alias ? { alias } : {}),
    };
  });
  const settings = currentSettingsItems().map((item) => ({
    id: item.id,
    title: item.title,
    item,
  }));
  const results = recentActivity().map((entry) => ({
    id: entry.id,
    title: [entry.title, entry.message].filter(Boolean).join(" · "),
    entry,
  }));
  const built = [
    ...rankRows(query, commands, prefs.lastUsed).map(({ entry }) =>
      commandRow(entry, "Commands"),
    ),
    ...rankRows(query, settings, []).map(({ item }) => settingRow(item, true)),
    ...rankRows(query, results, []).map(({ entry }) =>
      activityRow(entry, "Recent"),
    ),
  ];
  return numbered({
    rows: built,
    empty: `No commands or settings match “${query.trim()}”.`,
  });
}

function nowRows(): Row[] {
  const workflow = data?.workflow;
  if (!workflow || !RUNNING.has(workflow.status) || !fresh(workflow)) return [];
  const elapsed = formatClock(
    Math.max(
      0,
      Math.round((Date.now() - Date.parse(workflow.updatedAt)) / 1_000),
    ),
  );
  if (workflow.status === "picking") {
    return [
      {
        group: "Now",
        title:
          workflow.actionId === PICK_VIDEO_ACTION_ID
            ? "Picking a post…"
            : workflow.actionId === DOWNLOAD_ACTION_ID &&
                workflow.message === MEDIA_PICK_MESSAGE
              ? "Picking an image or a video…"
              : "Picking an image…",
        subtitle: elapsed,
        icon: "x",
        value: "Cancel pick",
        verb: "Run",
        run: () => sendThenClose({ type: "cancel-active" }),
      },
    ];
  }
  if (workflow.status === "sending")
    return [
      {
        group: "Now",
        title: "Sending to DigiBot…",
        subtitle: "Queued status only",
        icon: "clock",
        verb: "Run",
      },
    ];
  if (workflow.actionId === AUDIO_ACTION_ID)
    return [
      {
        group: "Now",
        title: "Verifying audio",
        subtitle: elapsed,
        icon: "waveform",
        verb: "Run",
      },
    ];
  return [
    {
      group: "Now",
      title: "Verifying image",
      subtitle: elapsed,
      icon: "x",
      value: "Cancel verification",
      verb: "Run",
      run: () => sendThenClose({ type: "cancel-active" }),
    },
  ];
}

function setupRows(): Row[] {
  if (!data) return [];
  return finishSetupItems({
    connected: data.context.connected,
    pairingPending: data.pending !== null,
    optionalAccess: data.optionalAccess,
    // An empty shortcut means another extension or the browser holds ⌥⇧Space.
    paletteShortcut: data.shortcuts.get("open-palette"),
  }).map((item): Row => {
    const row: Row = {
      group: "Finish setup",
      title: item.title,
      subtitle: item.subtitle,
      verb: "Open",
    };
    switch (item.id) {
      case "connect":
        return {
          ...row,
          icon: "plug",
          trailing: "›",
          run: () => pushView("connect"),
        };
      case "complete-pairing":
        return { ...row, icon: "plug", verb: "Run", run: completePairing };
      case "optional-access":
        return {
          ...row,
          icon: "lock",
          trailing: "↗",
          run: () => openTab("access"),
        };
      case "palette-shortcut":
        return {
          ...row,
          icon: "keyboard",
          trailing: "↗",
          run: () => openTab("shortcuts"),
        };
    }
  });
}

function downloadRows(): Row[] {
  const page = context();
  const built: Row[] = [];
  if (!page.connected)
    built.push({
      group: "DigiBot",
      title: "Connect DigiBot",
      subtitle: "Needed for Download and Clip",
      icon: "plug",
      trailing: "›",
      verb: "Open",
      run: () => pushView("connect"),
    });
  const target = page.hostname || "no page";
  const pageGroup =
    page.scope === "video" ? `This video · ${target}` : `This page · ${target}`;
  for (const id of [
    "send-page-video",
    "send-page-audio",
    "send-page-audio-file",
    "open-clip",
  ]) {
    const entry = paletteCommand(id);
    if (!entry) continue;
    const row = commandRow(entry, pageGroup);
    // X and YouTube listing pages: the worker starts the picker.
    built.push(
      page.needsPick && !row.warn
        ? { ...row, subtitle: "Pick a post on this page" }
        : row,
    );
  }
  for (const id of [
    "pick-media-telegram",
    "pick-post-audio",
    "pick-post-audio-file",
  ]) {
    const entry = paletteCommand(id);
    if (entry) built.push(commandRow(entry, "Pick on the page"));
  }
  return built;
}

function verifyRows(): Row[] {
  const built: Row[] = [];
  const image = paletteCommand("pick-image");
  if (image)
    built.push({ ...commandRow(image, "Image"), value: context().verifyMode });
  for (const [id, group] of [
    ["check-synthid", "Image"],
    ["verify-page-audio", "Audio"],
    ["verify-audio-file", "Audio"],
  ] as const) {
    const entry = paletteCommand(id);
    if (entry) built.push(commandRow(entry, group));
  }
  const cancel = paletteCommand("cancel-active");
  if (cancel && runningVerification()) built.push(commandRow(cancel, "Now"));
  return built;
}

function clipView(): BuiltView {
  const text = input.value.trim();
  const range = text ? parseClockRange(text) : null;
  const page = context(range);
  const built: Row[] = [];
  for (const id of ["send-clip", "pick-post-clip", "verify-clip-audio"]) {
    const entry = paletteCommand(id);
    if (!entry) continue;
    // The audio check covers 1 to 60 s; a longer clip hides its row.
    if (id === "verify-clip-audio" && range?.ok && !fitsAudioCheck(range))
      continue;
    const row = commandRow(entry, "Clip", page);
    built.push(
      id === "send-clip" && range?.ok && !row.warn
        ? { ...row, subtitle: `${rangeText(range)} → Telegram` }
        : row,
    );
  }
  const hint = rangeHint(range, "Clip");
  return numbered({ rows: built, ...(hint ? { hint } : {}) });
}

function audioRangeView(): BuiltView {
  const text = input.value.trim();
  const parsed = text ? parseClockRange(text) : null;
  const range =
    parsed?.ok && !fitsAudioCheck(parsed)
      ? { ok: false as const, message: AUDIO_RANGE_MESSAGE }
      : parsed;
  const entry = paletteCommand("verify-clip-audio");
  if (!entry) return { rows: [] };
  const row = commandRow(entry, "Audio of this page", context(range));
  const hint = rangeHint(range, "Check");
  return numbered({
    rows: [
      {
        ...row,
        title: "Verify audio of this page",
        subtitle:
          range?.ok && !row.warn
            ? `${rangeText(range)} · DigiBot check`
            : row.subtitle,
      },
    ],
    ...(hint ? { hint } : {}),
  });
}

function recentView(): BuiltView {
  const recent = recentActivity();
  const built = recent.map((entry) => activityRow(entry, "Actions"));
  const history = paletteCommand("open-history");
  if (history) built.push(commandRow(history, "More"));
  return numbered({
    rows: built,
    notes: recent.length === 0 ? ["No actions yet."] : [],
  });
}

function aliasView(): BuiltView {
  const entry = aliasTarget ? paletteCommand(aliasTarget) : undefined;
  if (!entry || !data) return { rows: [] };
  const aliases = effectiveAliases(data.prefs);
  const check = checkAlias(input.value, entry.id, aliases);
  return numbered({
    rows: [
      {
        group: `Alias for ${entry.title}`,
        title: "Save alias",
        subtitle: !check.ok
          ? check.message
          : check.alias === null
            ? "Clear the alias"
            : check.alias,
        warn: !check.ok,
        icon: "key",
        verb: "Save",
        ...(check.ok ? { run: () => saveAlias(entry.id, check.alias) } : {}),
      },
    ],
    hint: check.ok
      ? { text: ALIAS_RULE, error: false }
      : { text: check.message, error: true },
  });
}

// Settings -------------------------------------------------------------------

function currentSettingsItems(): SettingsItem[] {
  if (!data) return [];
  const shortcut = data.shortcuts.get("open-palette") ?? "";
  return settingsItems({
    settings: data.settings,
    connected: data.context.connected,
    paletteShortcut: shortcutKeys(shortcut),
    version: chrome.runtime.getManifest().version,
  });
}

/** The Settings view's rows. */
function settingsRows(): Row[] {
  return currentSettingsItems().map((item) => settingRow(item, false));
}

/** A Settings row; in search it shows its place as "Settings › {group}". */
function settingRow(item: SettingsItem, search: boolean): Row {
  const subtitle = item.subtitle ?? (search ? `Settings › ${item.group}` : "");
  const row: Row = {
    group: search ? "Settings" : item.group,
    title: item.title,
    subtitle,
    icon: item.icon,
    verb: RUN_VERBS[item.run.kind],
  };
  if (item.value) row.value = item.value;
  if (item.keys) row.keys = item.keys;
  if (item.setting) row.setting = item.setting;
  const run = item.run;
  switch (run.kind) {
    case "view":
      row.trailing = "›";
      row.run = () => pushView(run.view);
      break;
    case "toggle":
      row.run = () => toggleSetting(run.setting);
      break;
    case "tab":
      row.trailing = "↗";
      row.run = () => openTab(run.page);
      break;
    case "none":
      break;
  }
  return row;
}

function choiceView(view: ChoiceView): BuiltView {
  if (!data) return { rows: [] };
  const rows = choicesFor(view, data.settings).map((choice): Row => ({
    group: VIEW_LABELS[view].replace("Settings › ", ""),
    title: choice.title,
    subtitle: "",
    check: choice.current,
    verb: "Choose",
    run: async () => {
      if (await applySetting(choice.update)) back();
    },
  }));
  const built = filtered(rows);
  return view === "verification-mode"
    ? { ...built, hint: { text: MODE_DISCLOSURES.join("\n"), error: false } }
    : built;
}

/** A message, then Cancel (selected) and the danger action. */
function confirmView(view: ConfirmView): BuiltView {
  const { message, choices } = confirmFor(view, data?.history.length ?? 0);
  const [cancel, danger] = choices;
  return numbered({
    rows: [
      {
        group: "Confirm",
        title: cancel.title,
        subtitle: "",
        icon: "x",
        verb: "Run",
        run: back,
      },
      {
        group: "Confirm",
        title: danger.title,
        subtitle: "",
        icon: "alert-triangle",
        danger: true,
        verb: "Run",
        run: () => confirmed(view),
      },
    ],
    detail: { paragraphs: [message] },
  });
}

async function confirmed(view: ConfirmView): Promise<void> {
  switch (view) {
    case "disconnect": {
      stopPairing();
      back();
      connectStatus = { text: PAIRING_TEXT.disconnecting, error: false };
      render();
      const outcome = await disconnectDigiBot();
      connectStatus = outcome.ok
        ? null
        : { text: outcome.message, error: true };
      await reload();
      return;
    }
    case "clear-history":
      await finish(clearSavedHistory, "The history could not be cleared.");
      return;
    case "clear-cache":
      await finish(
        clearSavedCache,
        "The local verification cache could not be cleared.",
      );
      return;
    case "reset-aliases":
      if (data) await savePrefs({ ...data.prefs, aliases: {} });
      back();
      showSaved();
      return;
  }
}

/** Runs a Confirm's action, goes back and shows its message. */
async function finish(
  action: () => Promise<Outcome>,
  failure: string,
): Promise<void> {
  const outcome = await action().catch((): Outcome => ({
    ok: false,
    message: failure,
  }));
  back();
  showNotice(outcome);
}

function connectView(): BuiltView {
  if (!data) return { rows: [] };
  const { connected } = data.context;
  const pending = connected ? null : data.pending;
  const waiting = pairingPoll !== null;
  const status: Hint = connectStatus ?? {
    text: connected
      ? PAIRING_TEXT.connected
      : waiting
        ? PAIRING_TEXT.waiting
        : pending
          ? PAIRING_TEXT.ready
          : PAIRING_TEXT.notConnected,
    error: false,
  };
  const row = (
    title: string,
    subtitle: string,
    run: () => void | Promise<void>,
  ): Row => ({
    group: "DigiBot",
    title,
    subtitle,
    icon: "plug",
    verb: "Run",
    run,
  });
  const command = pending ? `/link ${pending.pairId}` : "";
  const rows: Row[] = [];
  if (connected)
    rows.push({
      ...row("Disconnect DigiBot…", "This browser only", () =>
        pushView("disconnect"),
      ),
      icon: "x",
      trailing: "›",
      verb: "Open",
    });
  else if (pending && !waiting)
    rows.push(
      row(
        "Complete DigiBot pairing",
        "Check whether you approved it",
        completePairing,
      ),
      {
        ...row("Copy /link", command, () => copyPairCommand(command)),
        icon: "copy",
      },
      row("Start again", "A new pairing request", startPairing),
    );
  else if (pending)
    rows.push({
      ...row("Copy /link", command, () => copyPairCommand(command)),
      icon: "copy",
    });
  else
    rows.push(
      row(
        connectStatus?.text === PAIRING_TEXT.timeout
          ? "Start again"
          : "Start pairing and copy /link",
        "Then approve the code in DigiBot",
        startPairing,
      ),
    );
  rows.push({
    group: "DigiBot",
    title: "Provider processing details",
    subtitle: "OpenAI content provenance",
    icon: "external",
    trailing: "↗",
    verb: "Open",
    run: () => openAddress(PROVIDER_DETAILS_URL),
  });
  const built = filtered(rows);
  return {
    ...built,
    ...(copySelected ? { hint: { text: COPY_HINT, error: false } } : {}),
    detail: {
      heading: "Connect DigiBot",
      status,
      ...(pending
        ? {
            pair: {
              command,
              code: formatPairingCode(pending.confirmationCode),
            },
          }
        : {}),
      paragraphs: [CONNECT_INTRO, CONNECT_CONSENT],
    },
  };
}

/** The 10 browser commands, each with its key; ↵ opens the shortcuts page. */
function hotkeyRows(): Row[] {
  return DECLARED_COMMAND_IDS.map((id): Row => {
    const shortcut = data?.shortcuts.get(id) ?? "";
    const row: Row = {
      group: "Command hotkeys",
      title: paletteCommand(id)?.title ?? "Open Lens palette",
      subtitle: "",
      icon: paletteCommand(id)?.icon ?? "keyboard",
      trailing: "↗",
      verb: "Open",
      run: () => openTab("shortcuts"),
    };
    if (shortcut) row.keys = shortcutKeys(shortcut);
    else row.value = "Not set";
    return row;
  });
}

/** Every command with its alias; ↵ edits it in the alias Form. */
function aliasRows(): Row[] {
  const aliases = data ? effectiveAliases(data.prefs) : {};
  const rows = PALETTE_COMMANDS.map((entry): Row => {
    const alias = aliases[entry.id];
    const row: Row = {
      group: "Aliases",
      title: entry.title,
      subtitle: entry.path,
      icon: entry.icon,
      trailing: "›",
      verb: "Open",
      run: () => editAlias(entry.id),
    };
    if (alias) row.alias = alias;
    else row.value = "No alias";
    return row;
  });
  rows.push({
    group: "Reset",
    title: "Reset aliases…",
    subtitle: "Back to the default aliases",
    icon: "x",
    trailing: "›",
    verb: "Open",
    run: () => pushView("reset-aliases"),
  });
  return rows;
}

/** A view's rows filtered by the typed text, numbered by position. */
function filtered(all: Row[]): BuiltView {
  const query = input.value.trim();
  const shown = query
    ? all.filter((row) => matchScore(query, row.title, row.alias) > 0)
    : all;
  return numbered({
    rows: shown,
    ...(query ? { empty: `No commands match “${query}”.` } : {}),
  });
}

function numbered(view: BuiltView): BuiltView {
  let digit = 0;
  return {
    ...view,
    rows: view.rows.map((row) =>
      digit < 9 ? { ...row, digit: (digit += 1) } : row,
    ),
  };
}

function commandRow(
  entry: PaletteCommand,
  group: string,
  page: PaletteContext = context(),
): Row {
  const gate = commandGate(entry, page);
  const aliases = data ? effectiveAliases(data.prefs) : {};
  const shortcut = isDeclaredCommand(entry.id)
    ? data?.shortcuts.get(entry.id)
    : undefined;
  const fix = gate?.fix;
  const row: Row = {
    group,
    title: entry.title,
    subtitle: gate?.reason ?? entry.subtitle,
    warn: gate !== null,
    icon: entry.icon,
    verb: fix ? "Open" : entry.verb,
    commandId: entry.id,
  };
  const alias = aliases[entry.id];
  if (alias) row.alias = alias;
  if (shortcut) row.keys = shortcutKeys(shortcut);
  if (entry.note) row.note = entry.note;
  if (entry.run.kind === "view") row.trailing = "›";
  else if (entry.run.kind === "tab" || entry.external) row.trailing = "↗";
  if (!gate) row.run = () => runCommand(entry);
  else if (fix) row.run = () => runCommandRun(fix);
  return row;
}

/** One started action, with its kind icon and its state. */
function activityRow(entry: ActivityEntry, group: string): Row {
  const history = data?.history ?? [];
  const shown = recentRow(
    entry,
    new Set(history.map(({ id }) => id)),
    timeAgo(entry.startedAt),
  );
  const row: Row = {
    group,
    title: shown.title,
    subtitle: shown.subtitle,
    warn: shown.warn,
    icon: shown.icon,
    value: shown.state,
    verb: "Open",
  };
  const open = shown.open;
  if (open === null) return row;
  if (open.page === "address")
    return { ...row, trailing: "↗", run: () => openAddress(open.url) };
  if (open.page === "history")
    return { ...row, trailing: "↗", run: () => openTab("history") };
  const saved = history.find(({ id }) => id === open.recordId);
  return saved
    ? { ...row, trailing: "↗", record: saved, run: () => openDetails(saved) }
    : row;
}

function recentActivity(): readonly ActivityEntry[] {
  return (data?.activity ?? []).slice(0, RECENT_LIMIT);
}

function runningVerification(): boolean {
  const workflow = data?.workflow;
  return (
    workflow !== null &&
    workflow !== undefined &&
    (workflow.status === "retrieving" || workflow.status === "verifying") &&
    workflow.actionId !== AUDIO_ACTION_ID &&
    fresh(workflow)
  );
}

function fresh(workflow: WorkflowState): boolean {
  return Date.now() - Date.parse(workflow.updatedAt) < FRESH_MS;
}

function rangeText(range: {
  startSeconds: number;
  endSeconds: number;
}): string {
  return `${formatClock(range.startSeconds)} → ${formatClock(range.endSeconds)} · ${formatDuration(range.endSeconds - range.startSeconds)}`;
}

function rangeHint(
  range: PaletteContext["range"],
  verb: string,
): Hint | undefined {
  if (!range) return undefined;
  if (!range.ok) return { text: range.message, error: true };
  return {
    text: `${verb} ${formatDuration(range.endSeconds - range.startSeconds)}, ${formatClock(range.startSeconds)} to ${formatClock(range.endSeconds)}`,
    error: false,
  };
}

// Running --------------------------------------------------------------------

async function runCommand(entry: PaletteCommand): Promise<void> {
  if (entry.leaf && data) await savePrefs(withLastUsed(data.prefs, entry.id));
  await runCommandRun(entry.run);
}

async function runCommandRun(run: CommandRun): Promise<void> {
  switch (run.kind) {
    case "view":
      pushView(run.view);
      return;
    case "tab":
      await openTab(run.page);
      return;
    case "cancel":
      await sendThenClose({ type: "cancel-active" });
      return;
    case "start": {
      const options = run.range ? typedRange() : run.options;
      if (run.range && !options) return;
      await sendThenClose({
        type: "start-action",
        actionId: run.actionId,
        // "popup" stands for the popup or the palette; the enum is unchanged.
        trigger: "popup",
        ...(options ? { options } : {}),
      });
      return;
    }
  }
}

/** The range typed in the Clip or audio form, when it is valid there. */
function typedRange(): LinkDownloadOptions | null {
  const range = parseClockRange(input.value);
  if (!range.ok) return null;
  if (currentView() === "audio-range" && !fitsAudioCheck(range)) return null;
  return { startSeconds: range.startSeconds, endSeconds: range.endSeconds };
}

/** Page work closes the palette at once; the page reports by toast. */
async function sendThenClose(message: ExtensionMessage): Promise<void> {
  spinner.hidden = false;
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    spinner.hidden = true;
    footerError = "The command could not be started.";
    renderFooter();
    return;
  }
  close();
}

async function openTab(page: TabPage): Promise<void> {
  try {
    await openTabPage(page);
  } catch {
    footerError = "The page could not be opened.";
    renderFooter();
    return;
  }
  close();
}

/** The address a page link sent, in a new tab. */
async function openAddress(address: string): Promise<void> {
  try {
    await chrome.tabs.create({ url: address });
  } catch {
    footerError = "The page could not be opened.";
    renderFooter();
    return;
  }
  close();
}

async function openDetails(saved: HistoryRecord): Promise<void> {
  try {
    await chrome.tabs.create({
      url: `${chrome.runtime.getURL("details.html")}?id=${encodeURIComponent(saved.id)}`,
    });
  } catch {
    footerError = "The result could not be opened.";
    renderFooter();
    return;
  }
  close();
}

async function savePrefs(prefs: PalettePrefs): Promise<void> {
  if (data) data = { ...data, prefs };
  try {
    await chrome.storage.local.set({ [PALETTE_PREFS_KEY]: prefs });
  } catch {
    // Aliases and Last used are conveniences; the command still runs.
  }
}

async function saveAlias(
  commandId: string,
  alias: string | null,
): Promise<void> {
  if (!data) return;
  await savePrefs(withAlias(data.prefs, commandId, alias));
  showSaved();
  if (currentView() === "alias") back();
  else render();
}

function editAlias(commandId: string): void {
  aliasTarget = commandId;
  pushView("alias");
  input.value = data ? (effectiveAliases(data.prefs)[commandId] ?? "") : "";
  render();
}

/** Saves one setting at once; the footer says "Saved" for 2.5 s. */
function applySetting(update: SettingUpdate): Promise<boolean> {
  return showSave(saveSetting(update));
}

async function toggleSetting(key: SettingKey): Promise<void> {
  await showSave(flipSetting(key));
}

async function showSave(save: Promise<PaletteSettings>): Promise<boolean> {
  try {
    const settings = await save;
    if (data)
      data = {
        ...data,
        settings,
        context: {
          ...data.context,
          verifyMode: verifyModeText(data.context.connected, settings),
        },
      };
  } catch {
    footerError = "The setting could not be saved.";
    renderFooter();
    return false;
  }
  showSaved();
  render();
  return true;
}

function showSaved(text = "Saved"): void {
  savedText = text;
  savedUntil = Date.now() + SAVED_NOTE_MS;
  setTimeout(renderFooter, SAVED_NOTE_MS + 50);
  renderFooter();
}

function showNotice(outcome: Outcome): void {
  notice = { text: outcome.message, error: !outcome.ok };
  render();
}

// Pairing ------------------------------------------------------------------

/**
 * Start pairing and Start again: a new pairing, its /link copied. While the
 * request is created, neither this nor Complete DigiBot pairing does anything.
 */
async function startPairing(): Promise<void> {
  if (creatingPairing) return;
  creatingPairing = true;
  stopPairing();
  copySelected = false;
  connectStatus = { text: PAIRING_TEXT.creating, error: false };
  render();
  let pairing: Awaited<ReturnType<typeof createPairing>>;
  try {
    pairing = await createPairing();
  } catch {
    connectStatus = { text: PAIRING_TEXT.createFailed, error: true };
    render();
    return;
  } finally {
    creatingPairing = false;
  }
  connectStatus = null;
  if (data)
    data = {
      ...data,
      pending: {
        pairId: pairing.pairId,
        confirmationCode: pairing.confirmationCode,
        expiresAt: pairing.expiresAt,
      },
    };
  watchPairing(Date.now(), false);
  render();
  await copyPairCommand(`/link ${pairing.pairId}`);
}

/** Complete DigiBot pairing: asks at once, then on the same schedule. */
function completePairing(): void {
  const pending = data?.pending;
  if (!pending || creatingPairing) return;
  connectStatus = null;
  // The new status rebuilds the Detail, and a selected /link with it.
  copySelected = false;
  if (currentView() !== "connect") pushView("connect");
  watchPairing(pairingStartedAt(pending.expiresAt), true);
  render();
}

function watchPairing(startedAt: number, immediate: boolean): void {
  pairingPoll?.stop();
  const poll = pollPairing({ startedAt, immediate });
  pairingPoll = poll;
  void poll.done.then((outcome) => {
    if (pairingPoll !== poll) return;
    pairingPoll = null;
    copySelected = false;
    if (outcome === "timeout")
      connectStatus = { text: PAIRING_TEXT.timeout, error: true };
    void reload();
  });
}

function stopPairing(): void {
  const poll = pairingPoll;
  pairingPoll = null;
  poll?.stop();
}

async function copyPairCommand(command: string): Promise<void> {
  const result = await copyText(
    command,
    hostKind,
    document.getElementById("pair-command"),
  );
  copySelected = result === "selected";
  if (result === "copied") showSaved("Copied /link");
  render();
}

function pushView(view: PaletteView): void {
  closeActions();
  stack.push(view);
  input.value = "";
  active = 0;
  notice = null;
  copySelected = false;
  render();
  // The /link fallback may have focused text this view no longer shows.
  input.focus();
}

function back(): void {
  if (stack.length <= 1) return;
  closeActions();
  if (stack.pop() === "alias") aliasTarget = null;
  input.value = "";
  active = 0;
  notice = null;
  copySelected = false;
  render();
  input.focus();
}

/**
 * In a page, the close goes over the frame's port, which no page listener can
 * stop, and as a message to the host's window.
 */
function close(): void {
  if (!embedded) {
    window.close();
    return;
  }
  const request = {
    lens: "close",
    held: [...heldKeys],
  } satisfies PaletteHostClose;
  try {
    ownPort?.postMessage(request);
  } catch {
    // The port is gone; the window message still reaches the host.
  }
  window.parent.postMessage(request, parentOrigin());
}

function parentOrigin(): string {
  const origin = location.ancestorOrigins?.[0];
  return origin && /^https?:\/\/[^/]+$/u.test(origin) ? origin : "*";
}

// Keys -----------------------------------------------------------------------

function onKeyDown(event: KeyboardEvent): void {
  heldKeys.add(event.code);
  const key = paletteKey(event, {
    actionsOpen,
    query: actionsOpen ? actionsInput.value : input.value,
    depth: stack.length - 1,
  });
  if (key.type === "none") return;
  event.preventDefault();
  event.stopPropagation();
  // Only the latest key may wait for the panel.
  clearHeld();
  switch (key.type) {
    case "digit":
      if (actionsOpen) runAction(key.index, "key");
      else
        runRow(
          rows.findIndex((row) => row.digit === key.index + 1),
          "key",
        );
      return;
    case "move":
      if (actionsOpen) setActionActive(actionActive + key.delta);
      else setActive(wrap(active + key.delta, rows.length));
      return;
    case "edge":
      if (actionsOpen)
        setActionActive(key.edge === "first" ? 0 : shownActions.length - 1);
      else setActive(key.edge === "first" ? 0 : rows.length - 1);
      return;
    case "run":
      if (actionsOpen) runAction(actionActive, "key");
      else runRow(active, "key");
      return;
    case "actions":
      toggleActions();
      return;
    case "escape":
      if (key.step === "close-actions") closeActions();
      else if (key.step === "clear-query") {
        input.value = "";
        active = 0;
        render();
      } else if (key.step === "back") back();
      else if (currentView() === "disclosure") void cancelDisclosure();
      else close();
      return;
    case "back":
      back();
      return;
    case "tab": {
      // A manual trap: focus never leaves the frame for the page.
      const stops = actionsOpen ? [actionsInput] : [input, actionsButton];
      const current = stops.indexOf(document.activeElement as HTMLInputElement);
      stops[nextTabStop(current, stops.length, key.backward)]?.focus();
      return;
    }
  }
}

function runRow(index: number, source: InputSource): void {
  const row = rows[index];
  if (!row) return;
  gated(source, async () => {
    // A key that waited runs the row it was pressed on.
    const shown = rows.indexOf(row);
    if (shown >= 0) setActive(shown);
    await row.run?.();
  });
}

function wrap(index: number, count: number): number {
  return count === 0 ? 0 : (index + count) % count;
}

// The ⌘K panel ---------------------------------------------------------------

function toggleActions(): void {
  if (actionsOpen) {
    closeActions();
    return;
  }
  const row = rows[active];
  if (!row) return;
  actionItems = actionsFor(row);
  if (actionItems.length === 0) return;
  actionsOpen = true;
  actionActive = 0;
  actionsInput.value = "";
  actionsPanel.hidden = false;
  actionsButton.setAttribute("aria-expanded", "true");
  renderActions();
  actionsInput.focus();
}

function closeActions(): void {
  if (!actionsOpen) return;
  actionsOpen = false;
  actionsPanel.hidden = true;
  actionsButton.setAttribute("aria-expanded", "false");
  input.focus();
}

function actionsFor(row: Row): ActionItem[] {
  const index = rows.indexOf(row);
  // runAction has already checked the input.
  const run = async (): Promise<void> => {
    setActive(index);
    await row.run?.();
  };
  const saved = row.record;
  if (saved)
    return [
      { title: "Open details", keys: ["↵"], run },
      { title: "Open history", run: () => openTab("history") },
    ];
  const entry = row.commandId ? paletteCommand(row.commandId) : undefined;
  const items: ActionItem[] = row.run
    ? [{ title: "Run", keys: ["↵"], run }]
    : [];
  const setting = row.setting;
  if (setting)
    items.push({
      title: "Reset to default",
      run: async () => {
        await applySetting(defaultFor(setting));
      },
    });
  if (!entry) return items;
  items.push({
    title: "Set alias…",
    run: () => editAlias(entry.id),
  });
  if (row.alias)
    items.push({ title: "Clear alias", run: () => saveAlias(entry.id, null) });
  // Chromium has no commands.update; the browser's page records the key.
  if (isDeclaredCommand(entry.id))
    items.push({ title: "Set hotkey…", run: () => openTab("shortcuts") });
  return items;
}

function runAction(index: number, source: InputSource): void {
  const item = shownActions[index];
  if (!item) return;
  gated(source, async () => {
    closeActions();
    await item.run();
  });
}

function setActionActive(index: number): void {
  actionActive = wrap(index, shownActions.length);
  renderActions();
}

function renderActions(): void {
  const query = actionsInput.value.trim();
  shownActions = query
    ? actionItems.filter((item) => matchScore(query, item.title) > 0)
    : actionItems;
  actionActive = Math.min(actionActive, Math.max(0, shownActions.length - 1));
  actionsList.replaceChildren(
    ...shownActions.map((item, index) => {
      const option = document.createElement("div");
      option.className = "row";
      option.id = `action-${index}`;
      option.setAttribute("role", "option");
      if (index === actionActive) option.setAttribute("aria-selected", "true");
      const title = document.createElement("span");
      title.className = "row-title";
      title.textContent = item.title;
      const right = document.createElement("span");
      right.className = "row-right";
      for (const key of item.keys ?? []) right.append(keycap(key));
      option.append(title, right);
      option.addEventListener("mousemove", () => {
        if (actionActive !== index) setActionActive(index);
      });
      // Only a real click: a script's click() runs nothing.
      option.addEventListener("click", (event) => {
        if (event.isTrusted) runAction(index, "pointer");
      });
      return option;
    }),
  );
  const current = shownActions[actionActive];
  if (current)
    actionsInput.setAttribute(
      "aria-activedescendant",
      `action-${actionActive}`,
    );
  else actionsInput.removeAttribute("aria-activedescendant");
}

// Rendering ------------------------------------------------------------------

function render(): void {
  if (!data) return;
  const view = currentView();
  const built = buildView(view);
  rows = built.rows;
  active = Math.min(active, Math.max(0, rows.length - 1));
  renderSearchBar(view);
  renderHint(notice ?? built.hint);
  renderDetail(built.detail);
  renderList(built);
  renderFooter();
  const query = input.value.trim();
  // The hint has a role only for errors and the status paragraph is rebuilt,
  // so a success notice and the Connect status are announced here too.
  const announcement =
    query && !FORM_VIEWS.has(view)
      ? `${rows.length} ${rows.length === 1 ? "result" : "results"}`
      : notice && !notice.error
        ? notice.text
        : (built.detail?.status?.text ?? "");
  if (live.textContent !== announcement) live.textContent = announcement;
}

function renderSearchBar(view: PaletteView): void {
  const depth = stack.length - 1;
  backButton.hidden = depth === 0;
  chip.hidden = depth === 0;
  chip.textContent = VIEW_LABELS[view];
  const page = context();
  input.placeholder =
    view === "root"
      ? "Search commands and settings"
      : view === "clip"
        ? "Start-end, e.g. 1:30-2:10"
        : view === "audio-range"
          ? "Start-end, 1 to 60 s, e.g. 0:30-1:00"
          : view === "alias"
            ? `Alias for ${aliasTarget ? (paletteCommand(aliasTarget)?.title ?? "") : ""}`
            : `Search ${VIEW_LABELS[view].split(" › ").at(-1) ?? ""}`;
  const label =
    view === "clip"
      ? "Clip range"
      : view === "audio-range"
        ? "Audio range"
        : view === "alias"
          ? "Alias"
          : null;
  if (label) input.setAttribute("aria-label", label);
  else input.removeAttribute("aria-label");
  accessory.replaceChildren();
  if (page.page === "none" && hostKind !== "page") {
    accessory.append(icon("lock"), "No page");
  } else if (page.scope === "video" && view === "download") {
    accessory.append(`Video · ${page.hostname}`);
  } else {
    accessory.append(page.hostname);
  }
}

function renderHint(hint: Hint | undefined): void {
  hintElement.hidden = !hint;
  hintElement.textContent = hint?.text ?? "";
  hintElement.classList.toggle("error", hint?.error === true);
  if (hint?.error) {
    hintElement.setAttribute("role", "alert");
    input.setAttribute("aria-invalid", "true");
  } else {
    hintElement.removeAttribute("role");
    input.removeAttribute("aria-invalid");
  }
}

/**
 * A Detail or Confirm view's text, above its rows. It is rebuilt only when
 * it changes, so a /link selected for a keyboard copy stays selected.
 */
function renderDetail(detail: Detail | undefined): void {
  panelElement.classList.toggle("has-detail", detail !== undefined);
  detailElement.hidden = detail === undefined;
  if (detail) input.setAttribute("aria-describedby", "detail");
  else input.removeAttribute("aria-describedby");
  const key = detail ? JSON.stringify(detail) : "";
  if (key === detailKey) return;
  detailKey = key;
  const children: HTMLElement[] = [];
  if (detail?.heading) {
    const heading = document.createElement("h2");
    heading.textContent = detail.heading;
    children.push(heading);
  }
  if (detail?.status) {
    const status = document.createElement("p");
    status.className = detail.status.error
      ? "detail-status error"
      : "detail-status";
    status.setAttribute("role", "status");
    status.textContent = detail.status.text;
    children.push(status);
  }
  if (detail?.pair) {
    const pair = document.createElement("div");
    pair.className = "pair";
    const instruction = document.createElement("p");
    instruction.textContent = PAIR_INSTRUCTION;
    const command = document.createElement("code");
    command.id = "pair-command";
    command.className = "pair-command";
    command.tabIndex = -1;
    command.textContent = detail.pair.command;
    const code = document.createElement("p");
    code.className = "pair-code";
    code.textContent = `Confirmation code ${detail.pair.code}`;
    pair.append(instruction, command, code);
    children.push(pair);
  }
  for (const text of detail?.paragraphs ?? []) {
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    children.push(paragraph);
  }
  // Focus in the old Detail, on a selected /link, goes back to the search field.
  const focused = detailElement.contains(document.activeElement);
  detailElement.replaceChildren(...children);
  if (focused) input.focus();
}

function renderList(built: BuiltView): void {
  const children: HTMLElement[] = [];
  let group: HTMLElement | null = null;
  let groupName: string | null = null;
  rows.forEach((row, index) => {
    if (!group || row.group !== groupName) {
      groupName = row.group;
      group = document.createElement("div");
      group.setAttribute("role", "group");
      const header = document.createElement("div");
      header.className = "group-header";
      header.id = `group-${children.length}`;
      header.setAttribute("role", "presentation");
      header.textContent = row.group;
      group.setAttribute("aria-labelledby", header.id);
      group.append(header);
      children.push(group);
    }
    group.append(...rowElements(row, index));
  });
  if (rows.length === 0 && built.empty) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = built.empty;
    children.push(empty);
  }
  for (const text of built.notes ?? []) {
    const note = document.createElement("p");
    note.className = "list-note";
    note.textContent = text;
    children.push(note);
  }
  list.replaceChildren(...children);
  updateActive();
}

function rowElements(row: Row, index: number): HTMLElement[] {
  const option = document.createElement("div");
  option.className = row.danger ? "row danger" : "row";
  option.id = `row-${index}`;
  option.setAttribute("role", "option");
  if (!row.run) option.setAttribute("aria-disabled", "true");
  if (row.digit !== undefined)
    option.setAttribute("aria-keyshortcuts", `Alt+${row.digit}`);
  const lead = document.createElement("span");
  lead.className = "row-icon";
  if (row.dot) {
    const dot = document.createElement("span");
    dot.className = `dot ${row.dot}`;
    lead.append(dot);
  } else if (row.icon) lead.append(icon(row.icon));
  const text = document.createElement("span");
  text.className = "row-text";
  const title = document.createElement("span");
  title.className = "row-title";
  title.textContent = row.title;
  const subtitle = document.createElement("span");
  subtitle.className = row.warn ? "row-subtitle warn" : "row-subtitle";
  subtitle.textContent = row.subtitle;
  text.append(title, subtitle);
  const right = document.createElement("span");
  right.className = "row-right";
  if (row.check) {
    const check = icon("check");
    check.classList.add("current");
    right.append(check);
    option.setAttribute("aria-current", "true");
  }
  if (row.value) right.append(row.value);
  if (row.alias) {
    const alias = document.createElement("span");
    alias.className = "alias";
    alias.textContent = row.alias;
    right.append(alias);
  }
  for (const key of row.keys ?? []) right.append(keycap(key));
  if (row.digit !== undefined) {
    const quick = document.createElement("span");
    quick.className = "quick";
    quick.textContent = IS_MAC ? `⌥${row.digit}` : `Alt ${row.digit}`;
    right.append(quick);
  }
  if (row.trailing) {
    const trailing = document.createElement("span");
    trailing.className = "trailing";
    trailing.setAttribute("aria-hidden", "true");
    trailing.textContent = row.trailing;
    right.append(trailing);
  }
  option.append(lead, text, right);
  option.addEventListener("mousemove", () => {
    if (active !== index) setActive(index);
  });
  // Only a real click: a script's click() runs nothing.
  option.addEventListener("click", (event) => {
    if (event.isTrusted) runRow(index, "pointer");
  });
  option.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    setActive(index);
    toggleActions();
  });
  if (!row.note) return [option];
  const note = document.createElement("div");
  note.className = "row-note";
  note.id = `note-${index}`;
  note.setAttribute("role", "presentation");
  note.textContent = row.note;
  option.setAttribute("aria-describedby", note.id);
  return [option, note];
}

function setActive(index: number): void {
  if (rows.length === 0) return;
  active = Math.min(Math.max(index, 0), rows.length - 1);
  updateActive();
  renderFooter();
}

function updateActive(): void {
  for (const option of list.querySelectorAll('[role="option"]'))
    option.removeAttribute("aria-selected");
  const option = document.getElementById(`row-${active}`);
  if (!option || rows.length === 0) {
    input.removeAttribute("aria-activedescendant");
    return;
  }
  option.setAttribute("aria-selected", "true");
  input.setAttribute("aria-activedescendant", option.id);
  option.scrollIntoView?.({ block: "nearest" });
}

function renderFooter(): void {
  const workflow = data?.workflow;
  const connected = data?.context.connected === true;
  let text = connected ? "DigiBot connected" : "Not connected";
  let tone = connected ? "ok" : "neutral";
  if (footerError) {
    text = footerError;
    tone = "danger";
  } else if (Date.now() < savedUntil) {
    text = savedText;
    tone = "ok";
  } else if (
    workflow &&
    workflow.message &&
    workflow.message !== "Ready" &&
    fresh(workflow)
  ) {
    text = workflow.message;
    tone = workflow.status === "error" ? "danger" : tone;
  }
  statusText.textContent = text;
  statusDot.className = `dot ${tone}`;
  footerBack.hidden = stack.length <= 1;
  footerVerb.textContent = rows[active]?.verb ?? "Open";
}

function icon(name: IconName): SVGSVGElement {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(namespace, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

function keycap(text: string): HTMLElement {
  const key = document.createElement("kbd");
  key.textContent = text;
  return key;
}

function timeAgo(createdAt: string): string {
  const minutes = Math.floor((Date.now() - Date.parse(createdAt)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}.`);
  return element as T;
}
