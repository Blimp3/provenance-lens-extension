import {
  AUDIO_ACTION_ID,
  DOWNLOAD_ACTION_ID,
  PICK_VIDEO_ACTION_ID,
  type ActivityEntry,
  type ExtensionMessage,
  type HistoryRecord,
  type LinkDownloadOptions,
  type WorkflowState,
} from "@provenance-lens/shared";

import { RECENT_LIMIT, recentRow } from "../activity.js";
import { isIntegrationConnected } from "../integration-client.js";
import {
  isOwnPalettePort,
  type PaletteHostAnswer,
  type PaletteHostCheck,
} from "../palette-host.js";
import {
  getActivity,
  getHistory,
  getSettings,
  getWorkflowState,
} from "../storage.js";
import {
  ALIAS_RULE,
  checkAlias,
  commandGate,
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
  run?: () => Promise<void>;
};
type ActionItem = {
  title: string;
  keys?: readonly string[];
  run: () => void | Promise<void>;
};
type Hint = { text: string; error: boolean };
type InputSource = "key" | "pointer";
type BuiltView = { rows: Row[]; hint?: Hint; notes?: string[]; empty?: string };
type FrameData = {
  context: PaletteContext;
  prefs: PalettePrefs;
  shortcuts: ReadonlyMap<string, string>;
  workflow: WorkflowState | null;
  history: readonly HistoryRecord[];
  activity: readonly ActivityEntry[];
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
/** Settings stays a page for now; these rows open it in a tab. */
const TAB_URLS: Readonly<Record<TabPage, string>> = {
  settings: "settings.html",
  connect: "settings.html#integration-heading",
  access: "settings.html#permissions-heading",
  history: "history.html",
  shortcuts: "chrome://extensions/shortcuts",
};
const VIEW_LABELS: Readonly<Record<PaletteView, string>> = {
  root: "",
  download: "Download",
  verify: "Verify",
  clip: "Clip",
  recent: "Recent",
  "audio-range": "Verify › Audio of this page",
  alias: "Set alias",
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

const paletteRoot = required<HTMLElement>("palette");
const scrim = required<HTMLElement>("scrim");
const backButton = required<HTMLButtonElement>("back");
const chip = required<HTMLButtonElement>("chip");
const input = required<HTMLInputElement>("query");
const accessory = required<HTMLElement>("accessory");
const spinner = required<HTMLElement>("spinner");
const hintElement = required<HTMLElement>("hint");
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
let footerError: string | null = null;
/** The panel's latest IntersectionObserver v2 visibility; none yet is hidden. */
let panelVisible = false;
let panelVisibleSince = 0;
/** When the frame told its host it was ready; 0 until then. */
let readyAt = 0;
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
    });
  }
  document.documentElement.classList.add(`host-${hostKind}`);
  const view = record?.view ?? "root";
  stack = view === "root" ? ["root"] : ["root", view];
  data = await loadData();
  wireEvents();
  paletteRoot.hidden = false;
  if (embedded) watchPanelVisibility();
  render();
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
  ] = await Promise.all([
    isIntegrationConnected().catch(() => false),
    getSettings().catch(() => null),
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
      verifyMode: connected
        ? "DigiBot check"
        : settings?.verificationMode === "api"
          ? "API check"
          : "OpenAI Verify site",
      range: null,
    },
    prefs: parsePalettePrefs(prefs),
    shortcuts,
    workflow,
    history,
    // History retention as it is now, also before the next start trims.
    activity: activity.slice(0, settings?.historyRetention ?? 0),
  };
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
    void loadData().then((next) => {
      data = next;
      render();
    });
  });
}

/**
 * A page can lay its own top-layer element over the host while clicks and
 * keys still reach the frame. IntersectionObserver v2 reports the panel
 * visible only when nothing covers it and no opacity, filter or transform
 * other than a 2D translation applies to it, the frame or the host, so input
 * runs only once it has been visible for a moment. The host closes the
 * palette when the page restyles it, which IntersectionObserver v2 would
 * not always see.
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
      if (visible && !panelVisible) panelVisibleSince = performance.now();
      panelVisible = visible;
      paletteRoot.dataset["visible"] = String(visible);
      if (visible) {
        clearCovered();
        runHeldWhenAllowed();
      } else {
        if (readyAt > 0) hiddenSinceReady = true;
        dropHeld();
      }
      // Chromium may keep reporting a frame hidden after the host hid and
      // showed it again (a fullscreen change, a closed dialog) until it is
      // observed afresh, so a hidden panel is observed again shortly.
      clearTimeout(recheck);
      if (!visible)
        recheck = setTimeout(() => {
          observer.unobserve(panel);
          observer.observe(panel);
        }, 250);
    },
    // trackVisibility and delay are IntersectionObserver v2 (Chromium).
    { trackVisibility: true, delay: 100 } as IntersectionObserverInit,
  );
  observer.observe(panel);
  // IntersectionObserver v2 does not count a zoom on the page as a
  // transform, but the zoom resizes the frame and moves the rows under a
  // resting pointer, so each resize restarts the visible clock.
  window.addEventListener("resize", () => {
    panelVisibleSince = performance.now();
    runHeldWhenAllowed();
  });
}

/**
 * Whether input may run now: in a page, a key once the panel has been
 * visible for 250 ms and a click once it has been visible for 500 ms, with
 * no hidden report in between. The popup and the tab are extension pages no
 * website can cover.
 */
function inputAllowed(source: InputSource): boolean {
  if (!embedded) return true;
  const visibleFor = source === "key" ? KEY_VISIBLE_MS : POINTER_VISIBLE_MS;
  return panelVisible && performance.now() - panelVisibleSince >= visibleFor;
}

/**
 * Runs a row or an action for a key or a click that inputAllowed lets
 * through. A key pressed in the frame's first second, while the panel has
 * not been reported hidden, waits until the panel has been visible long
 * enough; only the latest such key waits. Any other refused input is
 * dropped, and the footer says why.
 */
function gated(source: InputSource, run: () => Promise<void>): void {
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

function hostIntact(): Promise<boolean> {
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
    const timer = setTimeout(() => done(false), HOST_CHECK_MS);
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
  }
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
  const results = recentActivity().map((entry) => ({
    id: entry.id,
    title: [entry.title, entry.message].filter(Boolean).join(" · "),
    entry,
  }));
  const built = [
    ...rankRows(query, commands, prefs.lastUsed).map(({ entry }) =>
      commandRow(entry, "Commands"),
    ),
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
  // An empty shortcut means another extension or the browser holds ⌥⇧Space.
  if (data?.shortcuts.get("open-palette") !== "") return [];
  return [
    {
      group: "Finish setup",
      title: "Choose a palette shortcut",
      subtitle: "⌥⇧Space is taken",
      icon: "keyboard",
      trailing: "↗",
      verb: "Open",
      run: () => openTab("shortcuts"),
    },
  ];
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
      trailing: "↗",
      verb: "Open",
      run: () => openTab("connect"),
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
  const target = TAB_URLS[page];
  const url = target.startsWith("chrome://")
    ? target
    : chrome.runtime.getURL(target);
  try {
    await chrome.tabs.create({ url });
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
  savedUntil = Date.now() + SAVED_NOTE_MS;
  setTimeout(renderFooter, SAVED_NOTE_MS + 50);
  if (currentView() === "alias") back();
  else render();
}

function pushView(view: PaletteView): void {
  closeActions();
  stack.push(view);
  input.value = "";
  active = 0;
  render();
}

function back(): void {
  if (stack.length <= 1) return;
  closeActions();
  if (stack.pop() === "alias") aliasTarget = null;
  input.value = "";
  active = 0;
  render();
}

function close(): void {
  if (embedded)
    window.parent.postMessage(
      { lens: "close", held: [...heldKeys] },
      parentOrigin(),
    );
  else window.close();
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
  if (!entry) return items;
  items.push({
    title: "Set alias…",
    run: () => {
      aliasTarget = entry.id;
      pushView("alias");
      input.value = row.alias ?? "";
      render();
    },
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
      option.addEventListener("click", () => runAction(index, "pointer"));
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
  renderHint(built.hint);
  renderList(built);
  renderFooter();
  const query = input.value.trim();
  live.textContent =
    query && view !== "clip" && view !== "audio-range" && view !== "alias"
      ? `${rows.length} ${rows.length === 1 ? "result" : "results"}`
      : "";
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
            : `Search ${VIEW_LABELS[view]}`;
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
  option.className = "row";
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
  option.addEventListener("click", () => runRow(index, "pointer"));
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
    text = "Saved";
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
