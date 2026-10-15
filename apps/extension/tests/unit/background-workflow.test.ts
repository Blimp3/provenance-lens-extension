import {
  ACTION_ID,
  AUDIO_ACTION_ID,
  DISCLOSURE_VERSION,
  DOWNLOAD_ACTION_ID,
  LINK_ACTION_ID,
  PICK_VIDEO_ACTION_ID,
  SYNTHID_ACTION_ID,
  makeIndeterminateResult,
  type ActivityEntry,
} from "@provenance-lens/shared";
import { Blob as NodeBlob } from "node:buffer";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import type { VerificationOutcome } from "../../src/actions/verify-openai-provenance.js";
import type * as IntegrationClient from "../../src/integration-client.js";
import type * as Notifications from "../../src/notifications.js";

const mocks = vi.hoisted(() => ({
  actionHandler: vi.fn(),
  getActionDefinition: vi.fn(),
  createHistoryRecord: vi.fn(),
  verifyRetrievedImage: vi.fn(),
  appendHistory: vi.fn(),
  getHistory: vi.fn(),
  getLatestRecord: vi.fn(),
  getResult: vi.fn(),
  getSettings: vi.fn(),
  setWorkflowState: vi.fn(),
  updateSettings: vi.fn(),
  getSynthIdDisclosureVersion: vi.fn(),
  setSynthIdDisclosureVersion: vi.fn(),
  isIntegrationConnected: vi.fn(),
  runIntegratedImageAction: vi.fn(),
  runIntegratedAudioSegmentAction: vi.fn(),
  startActivity: vi.fn(),
  updateActivity: vi.fn(),
  getActivity: vi.fn(),
  resumePendingIntegrationOperations: vi.fn(),
  pendingIntegrationActivityIds: vi.fn(),
}));
/** Recent's list as the worker wrote it, newest first. */
const recent = vi.hoisted(() => ({ entries: [] as ActivityEntry[] }));

vi.mock("../../src/actions/registry.js", () => ({
  getActionDefinition: mocks.getActionDefinition,
}));

vi.mock("../../src/actions/verify-openai-provenance.js", () => ({
  createHistoryRecord: mocks.createHistoryRecord,
  verifyRetrievedImage: mocks.verifyRetrievedImage,
  USER_CANCELLED_REASON: "provenance-lens-user-cancelled",
  ExtensionWorkflowError: class MockExtensionWorkflowError extends Error {
    public constructor(
      public readonly code: string,
      message: string,
      public readonly retryable = false,
    ) {
      super(message);
    }
  },
}));

vi.mock("../../src/storage.js", () => ({
  STORAGE_KEYS: {
    settings: "provenanceLens.settings",
    history: "provenanceLens.history",
    workflow: "provenanceLens.workflow",
    latest: "provenanceLens.latest",
  },
  appendHistory: mocks.appendHistory,
  getActivity: mocks.getActivity,
  getHistory: mocks.getHistory,
  getLatestRecord: mocks.getLatestRecord,
  getResult: mocks.getResult,
  getSettings: mocks.getSettings,
  getSynthIdDisclosureVersion: mocks.getSynthIdDisclosureVersion,
  setSynthIdDisclosureVersion: mocks.setSynthIdDisclosureVersion,
  setWorkflowState: mocks.setWorkflowState,
  startActivity: mocks.startActivity,
  updateActivity: mocks.updateActivity,
  updateSettings: mocks.updateSettings,
}));

vi.mock("../../src/actions/integration-image.js", () => ({
  runIntegratedImageAction: mocks.runIntegratedImageAction,
}));

vi.mock("../../src/actions/integration-audio.js", () => ({
  runIntegratedAudioSegmentAction: mocks.runIntegratedAudioSegmentAction,
}));

// The real client has no storage here, so only the connection check is faked.
vi.mock("../../src/integration-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof IntegrationClient>()),
  isIntegrationConnected: mocks.isIntegrationConnected,
  pendingIntegrationActivityIds: mocks.pendingIntegrationActivityIds,
  resumePendingIntegrationOperations: mocks.resumePendingIntegrationOperations,
}));

// The binding helpers are pure and run as written; only the copy is faked.
vi.mock("../../src/notifications.js", async (importOriginal) => ({
  ...(await importOriginal<typeof Notifications>()),
  detectedToastCopy: vi.fn(() => ({
    title: "Detected",
    message: "A supported signal was detected.",
  })),
  errorToastCopy: vi.fn((reason: string) => ({
    title: "Verification failed",
    message: reason,
  })),
  noSignalToastCopy: vi.fn(() => ({
    title: "No signal",
    message: "No supported signal was detected.",
  })),
}));

const TAB_ID = 7;
const WINDOW_ID = 11;
const PAGE_URL = "https://page.example/";
const IMAGE_URL = "https://page.example/image.png";
const DATA_IMAGE_URL = "data:image/png;base64,iVBORw0KGgo=";
const BLOB_IMAGE_URL =
  "blob:https://page.example/123e4567-e89b-42d3-a456-426614174000";
const FIRST_RESULT_ID = "123e4567-e89b-42d3-a456-426614174000";
const SECOND_RESULT_ID = "223e4567-e89b-42d3-a456-426614174000";
const DOCUMENT_ID = "document-1";
const IMAGE_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function event() {
  return { addListener: vi.fn() };
}

function extensionPageSender(page: string): chrome.runtime.MessageSender {
  return { url: `chrome-extension://test/${page}` };
}

function apiSettings() {
  return {
    verificationMode: "api" as const,
    acknowledgedVerificationModes: ["api" as const],
    backendBaseUrl: "https://server.example",
    clientToken: "test-client-token",
    historyRetention: 20 as const,
    screenshotFallbackEnabled: true,
    includePageTitle: true,
    debugMode: false,
    localCacheLimit: 50,
    disclosureVersion: DISCLOSURE_VERSION,
  };
}

function selection() {
  return {
    url: IMAGE_URL,
    sourceKind: "img" as const,
    pageOrigin: "https://page.example",
    sourceHostname: "page.example",
    pageTitle: null,
    rect: {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      viewportWidth: 100,
      viewportHeight: 100,
      devicePixelRatio: 1,
    },
  };
}

function detectedOutcome() {
  return {
    result: {
      verdict: "openai_signal_detected" as const,
      summary: "Detected signals: C2PA.",
      signals: [
        {
          type: "c2pa" as const,
          outcome: "detected" as const,
          validationState: "valid" as const,
          issuer: null,
          model: null,
          generatedAt: null,
        },
      ],
      warnings: [],
      checkedAt: "2026-09-04T00:00:00.000Z",
      requestId: FIRST_RESULT_ID,
    },
    imageSha256: null,
    cache: null,
    errorCode: null,
    retrieved: null,
    manualFallbackAvailable: false,
    screenshotFallbackAvailable: false,
  };
}

function unavailableOutcome() {
  return {
    result: makeIndeterminateResult(
      "The verification server is unavailable.",
      FIRST_RESULT_ID,
    ),
    imageSha256: null,
    cache: null,
    errorCode: "backend_unavailable" as const,
    retrieved: null,
    manualFallbackAvailable: false,
    screenshotFallbackAvailable: true,
  };
}

function isErrorWorkflowState(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    value.status === "error"
  );
}

function setupChrome() {
  const onInstalled = event();
  const onStartup = event();
  const onMessage = event();
  const onConnect = event();
  const onCommand = event();
  const onActionClicked = event();
  const onContextMenuClicked = event();
  const onStorageChanged = event();
  const setBadgeText = vi.fn(({ text }: { text: string }) =>
    text === "…"
      ? Promise.resolve(undefined)
      : Promise.reject(new Error("intentional UI failure")),
  );
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const executeScript = vi.fn();
  const sessionGet = vi.fn().mockResolvedValue({});
  const sessionSet = vi.fn().mockResolvedValue(undefined);
  const sessionRemove = vi.fn().mockResolvedValue(undefined);
  const tab = { id: TAB_ID, url: PAGE_URL, windowId: WINDOW_ID };
  const tabsQuery = vi.fn().mockResolvedValue([tab]);
  const api = {
    runtime: {
      onInstalled,
      onStartup,
      onMessage,
      onConnect,
      getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
    },
    commands: { onCommand, getAll: vi.fn().mockResolvedValue([]) },
    contextMenus: {
      onClicked: onContextMenuClicked,
      removeAll: vi.fn().mockResolvedValue(undefined),
      create: vi.fn((_item: unknown, callback?: () => void) => callback?.()),
    },
    storage: {
      onChanged: onStorageChanged,
      local: {
        setAccessLevel: vi.fn().mockResolvedValue(undefined),
      },
      session: {
        get: sessionGet,
        set: sessionSet,
        remove: sessionRemove,
        setAccessLevel: vi.fn().mockResolvedValue(undefined),
      },
    },
    tabs: {
      query: tabsQuery,
      get: vi.fn().mockResolvedValue(tab),
      sendMessage,
      create: vi.fn().mockResolvedValue(tab),
      update: vi.fn().mockResolvedValue(tab),
      captureVisibleTab: vi.fn(),
      onRemoved: event(),
    },
    scripting: { executeScript },
    action: {
      setBadgeText,
      onClicked: onActionClicked,
      setPopup: vi.fn().mockResolvedValue(undefined),
      openPopup: vi.fn().mockResolvedValue(undefined),
    },
    windows: { update: vi.fn().mockResolvedValue({ id: WINDOW_ID }) },
    permissions: { contains: vi.fn().mockResolvedValue(true) },
    downloads: { download: vi.fn().mockResolvedValue(1) },
  } as unknown as typeof chrome;
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: api,
  });
  return {
    api,
    onActionClicked,
    onCommand,
    onConnect,
    onContextMenuClicked,
    onMessage,
    sendMessage,
    sessionGet,
    sessionSet,
    sessionRemove,
    executeScript,
    setBadgeText,
    tabsQuery,
  };
}

function setupMocks() {
  mocks.getActionDefinition.mockReturnValue({
    inputType: "image-file",
    handler: mocks.actionHandler,
  });
  mocks.getSettings.mockResolvedValue(apiSettings());
  mocks.getHistory.mockResolvedValue([]);
  mocks.getLatestRecord.mockResolvedValue(null);
  mocks.getResult.mockResolvedValue(null);
  mocks.appendHistory.mockResolvedValue(undefined);
  mocks.setWorkflowState.mockResolvedValue(undefined);
  mocks.updateSettings.mockResolvedValue(apiSettings());
  mocks.getSynthIdDisclosureVersion.mockResolvedValue(null);
  mocks.setSynthIdDisclosureVersion.mockResolvedValue(undefined);
  mocks.isIntegrationConnected.mockResolvedValue(false);
  mocks.resumePendingIntegrationOperations.mockResolvedValue(undefined);
  mocks.pendingIntegrationActivityIds.mockResolvedValue([]);
  // The list's own rules (retention, ended entries) are storage.test.ts's.
  recent.entries = [];
  mocks.getActivity.mockImplementation(() => Promise.resolve(recent.entries));
  mocks.startActivity.mockImplementation(
    (entry: ActivityEntry, retention: number) => {
      recent.entries = retention === 0 ? [] : [entry, ...recent.entries];
      return Promise.resolve();
    },
  );
  mocks.updateActivity.mockImplementation(
    (id: string, update: Partial<ActivityEntry>) => {
      recent.entries = recent.entries.map((entry) =>
        entry.id === id && entry.state === "running"
          ? { ...entry, ...update }
          : entry,
      );
      return Promise.resolve();
    },
  );
  let recordIndex = 0;
  mocks.createHistoryRecord.mockImplementation(
    (
      _selection: unknown,
      outcome: VerificationOutcome,
      _includePageTitle: boolean,
      inputKind: "original_file" | "screenshot_copy" = "original_file",
    ) => ({
      id:
        [FIRST_RESULT_ID, SECOND_RESULT_ID][recordIndex++] ?? SECOND_RESULT_ID,
      actionId: ACTION_ID,
      createdAt: "2026-09-04T00:00:00.000Z",
      sourceHostname: "page.example",
      pageTitle: null,
      inputKind,
      imageSha256: outcome.imageSha256,
      result: outcome.result,
      cache: outcome.cache,
      errorCode: outcome.errorCode,
      manualFallbackAvailable: outcome.manualFallbackAvailable,
      screenshotFallbackAvailable: outcome.screenshotFallbackAvailable,
    }),
  );
}

async function loadBackground() {
  await import("../../src/background.js");
}

async function waitForCall(mock: ReturnType<typeof vi.fn>, count: number) {
  await vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(count));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

/** The messages of one type that the worker sent to the page. */
function tabMessages(
  chromeState: ReturnType<typeof setupChrome>,
  type: string,
): Record<string, unknown>[] {
  return chromeState.sendMessage.mock.calls
    .map(([, message]) => message as Record<string, unknown>)
    .filter((message) => message["type"] === type);
}

describe("background verification workflow boundaries", () => {
  beforeEach(() => {
    vi.resetModules();
    setupMocks();
  });

  it.each([
    { trusted: false, openaiDetected: false, badge: "?" },
    { trusted: true, openaiDetected: false, badge: "✓" },
    { trusted: false, openaiDetected: true, badge: "✓" },
  ])(
    "uses evidence trust for the C2PA badge: %j",
    async ({ trusted, openaiDetected, badge }) => {
      const chromeState = setupChrome();
      chromeState.setBadgeText.mockResolvedValue(undefined);
      const detected = detectedOutcome();
      const outcome: VerificationOutcome = {
        ...detected,
        errorCode: openaiDetected ? null : "invalid_api_response",
        result: {
          ...detected.result,
          verdict: openaiDetected ? "openai_signal_detected" : "indeterminate",
          signals: openaiDetected ? detected.result.signals : [],
          contentCredentials: {
            status: "verified",
            signatureValid: true,
            contentBindingValid: true,
            signerTrusted: trusted,
            issuer: "Test signer",
            actions: [],
            aiDeclaration: "generated",
            validationCodes: [],
            trustListVersion: "6273cdcb4f27",
          },
        },
      };
      mocks.actionHandler.mockResolvedValue({ kind: "api", outcome });
      await loadBackground();
      const listener = chromeState.onContextMenuClicked.addListener.mock
        .calls[0]?.[0] as (
        info: chrome.contextMenus.OnClickData,
        tab: chrome.tabs.Tab,
      ) => void;
      listener(
        {
          menuItemId: ACTION_ID,
          srcUrl: IMAGE_URL,
          frameId: 0,
        } as chrome.contextMenus.OnClickData,
        { id: TAB_ID, url: PAGE_URL, windowId: WINDOW_ID } as chrome.tabs.Tab,
      );
      await waitForCall(mocks.appendHistory, 1);
      await vi.waitFor(() =>
        expect(chromeState.setBadgeText).toHaveBeenCalledWith({
          tabId: TAB_ID,
          text: badge,
        }),
      );
    },
  );

  it.each([
    { url: IMAGE_URL, sourceKind: "img" },
    { url: DATA_IMAGE_URL, sourceKind: "data-url" },
  ])(
    "keeps $sourceKind context-menu images on the direct path",
    async ({ url, sourceKind }) => {
      const chromeState = setupChrome();
      mocks.actionHandler.mockResolvedValue({
        kind: "api",
        outcome: detectedOutcome(),
      });
      await loadBackground();

      const listener = chromeState.onContextMenuClicked.addListener.mock
        .calls[0]?.[0] as (
        info: chrome.contextMenus.OnClickData,
        tab: chrome.tabs.Tab,
      ) => void;
      listener(
        {
          menuItemId: ACTION_ID,
          srcUrl: url,
          frameId: 0,
        } as chrome.contextMenus.OnClickData,
        { id: TAB_ID, url: PAGE_URL, windowId: WINDOW_ID } as chrome.tabs.Tab,
      );

      await waitForCall(mocks.actionHandler, 1);
      const input = mocks.actionHandler.mock.calls[0]?.[0] as {
        selection: { sourceKind: string; url: string };
      };
      expect(input.selection).toMatchObject({ sourceKind, url });
      expect(
        chromeState.sendMessage.mock.calls.some(
          ([, message]) =>
            (message as { type?: string })?.type === "picker-start",
        ),
      ).toBe(false);
    },
  );

  it("starts the picker for a blob context-menu image and asks for a fresh selection", async () => {
    const chromeState = setupChrome();
    chromeState.executeScript.mockResolvedValue([
      { frameId: 0, documentId: DOCUMENT_ID },
    ]);
    await loadBackground();

    const listener = chromeState.onContextMenuClicked.addListener.mock
      .calls[0]?.[0] as (
      info: chrome.contextMenus.OnClickData,
      tab: chrome.tabs.Tab,
    ) => void;
    listener(
      {
        menuItemId: ACTION_ID,
        srcUrl: BLOB_IMAGE_URL,
        frameId: 0,
      } as chrome.contextMenus.OnClickData,
      { id: TAB_ID, url: PAGE_URL, windowId: WINDOW_ID } as chrome.tabs.Tab,
    );

    await vi.waitFor(() =>
      expect(
        chromeState.sendMessage.mock.calls.some(
          ([, message]) =>
            (message as { type?: string })?.type === "picker-start",
        ),
      ).toBe(true),
    );
    await vi.waitFor(() =>
      expect(mocks.setWorkflowState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: "picking",
          actionId: ACTION_ID,
          message: "Select that image again to verify.",
        }),
      ),
    );
    expect(mocks.actionHandler).not.toHaveBeenCalled();
    expect(
      mocks.setWorkflowState.mock.calls.some(([state]) =>
        isErrorWorkflowState(state),
      ),
    ).toBe(false);
  });

  it("does not append a false error record after a saved result's UI fails", async () => {
    const chromeState = setupChrome();
    mocks.actionHandler.mockResolvedValue({
      kind: "api",
      outcome: detectedOutcome(),
    });
    await loadBackground();

    const listener = chromeState.onContextMenuClicked.addListener.mock
      .calls[0]?.[0] as (
      info: chrome.contextMenus.OnClickData,
      tab: chrome.tabs.Tab,
    ) => void;
    listener(
      {
        menuItemId: ACTION_ID,
        srcUrl: IMAGE_URL,
        frameId: 0,
      } as chrome.contextMenus.OnClickData,
      { id: TAB_ID, url: PAGE_URL, windowId: WINDOW_ID } as chrome.tabs.Tab,
    );
    await waitForCall(mocks.appendHistory, 1);
    await vi.waitFor(() =>
      expect(
        mocks.setWorkflowState.mock.calls.some(([state]) =>
          isErrorWorkflowState(state),
        ),
      ).toBe(true),
    );

    expect(mocks.createHistoryRecord).toHaveBeenCalledTimes(1);
    expect(mocks.appendHistory).toHaveBeenCalledTimes(1);
    expect(chromeState.setBadgeText).toHaveBeenCalledWith({
      tabId: TAB_ID,
      text: "!",
    });
  });

  it("reports connected cancellation as stopping the wait, not rolling back DigiBot", async () => {
    const chromeState = setupChrome();
    chromeState.setBadgeText.mockResolvedValue(undefined);
    mocks.isIntegrationConnected.mockResolvedValue(true);
    const { IntegrationClientError } =
      await import("../../src/integration-client.js");
    const message =
      "Stopped waiting for DigiBot. If it accepted the request, it may still finish and appear in History.";
    mocks.runIntegratedImageAction.mockRejectedValue(
      new IntegrationClientError(message, "user_cancelled", false),
    );
    await loadBackground();

    const listener = chromeState.onContextMenuClicked.addListener.mock
      .calls[0]?.[0] as (
      info: chrome.contextMenus.OnClickData,
      tab: chrome.tabs.Tab,
    ) => void;
    listener(
      {
        menuItemId: ACTION_ID,
        srcUrl: IMAGE_URL,
        frameId: 0,
      } as chrome.contextMenus.OnClickData,
      { id: TAB_ID, url: PAGE_URL, windowId: WINDOW_ID } as chrome.tabs.Tab,
    );

    await vi.waitFor(() =>
      expect(mocks.setWorkflowState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: "idle",
          actionId: null,
          message,
        }),
      ),
    );
    expect(
      mocks.setWorkflowState.mock.calls.some(([state]) =>
        isErrorWorkflowState(state),
      ),
    ).toBe(false);
    expect(chromeState.setBadgeText).toHaveBeenCalledWith({
      tabId: TAB_ID,
      text: "",
    });
  });

  it.each([
    { action: "Verify", actionId: ACTION_ID },
    { action: "Download", actionId: DOWNLOAD_ACTION_ID },
  ])(
    "treats a $action stop during image retrieval as a clean stop",
    async ({ actionId }) => {
      const chromeState = setupChrome();
      chromeState.setBadgeText.mockResolvedValue(undefined);
      chromeState.executeScript.mockResolvedValue([
        { frameId: 0, documentId: DOCUMENT_ID },
      ]);
      mocks.isIntegrationConnected.mockResolvedValue(true);
      const { ExtensionWorkflowError } =
        await import("../../src/actions/verify-openai-provenance.js");
      // The error image retrieval throws when the user stops it.
      mocks.runIntegratedImageAction.mockRejectedValue(
        new ExtensionWorkflowError(
          "user_cancelled",
          "Verification cancelled by the user.",
        ),
      );
      await loadBackground();

      const messageListener = chromeState.onMessage.addListener.mock
        .calls[0]?.[0] as (
        message: unknown,
        sender: chrome.runtime.MessageSender,
      ) => void;
      messageListener(
        { type: "start-action", actionId, trigger: "popup" },
        extensionPageSender("palette.html"),
      );
      await vi.waitFor(() =>
        expect(
          chromeState.sendMessage.mock.calls.some(
            ([, message]) =>
              (message as { type?: string })?.type === "picker-start",
          ),
        ).toBe(true),
      );
      const pickerStart = chromeState.sendMessage.mock.calls.find(
        ([, message]) =>
          (message as { type?: string })?.type === "picker-start",
      )?.[1] as { sessionToken: string };
      messageListener(
        {
          type: "picker-selected",
          sessionToken: pickerStart.sessionToken,
          selection: selection(),
        },
        {
          tab: { id: TAB_ID },
          frameId: 0,
          documentId: DOCUMENT_ID,
        } as chrome.runtime.MessageSender,
      );

      await waitForCall(mocks.runIntegratedImageAction, 1);
      await vi.waitFor(() =>
        expect(mocks.setWorkflowState).toHaveBeenLastCalledWith(
          expect.objectContaining({
            status: "idle",
            actionId: null,
            message: "Stopped before anything was sent.",
          }),
        ),
      );
      expect(mocks.createHistoryRecord).not.toHaveBeenCalled();
      expect(mocks.appendHistory).not.toHaveBeenCalled();
      expect(
        mocks.setWorkflowState.mock.calls.some(([state]) =>
          isErrorWorkflowState(state),
        ),
      ).toBe(false);
      // Only the progress toast showed, and the stop removed it: no result or
      // error toast. A connected Verify names its button Stop waiting.
      await vi.waitFor(() =>
        expect(tabMessages(chromeState, "hide-toast")).toHaveLength(1),
      );
      const toasts = tabMessages(chromeState, "show-toast");
      expect(toasts).toHaveLength(1);
      expect(toasts[0]).toMatchObject({ tone: "progress" });
      if (actionId === ACTION_ID)
        expect(toasts[0]).toMatchObject({ actions: ["stop-waiting"] });
      else expect(toasts[0]).not.toHaveProperty("actions");
      expect(chromeState.setBadgeText).toHaveBeenCalledWith({
        tabId: TAB_ID,
        text: "",
      });
    },
  );

  it("reports a save failure without creating a synthetic backend error record", async () => {
    const chromeState = setupChrome();
    mocks.actionHandler.mockResolvedValue({
      kind: "api",
      outcome: detectedOutcome(),
    });
    mocks.appendHistory.mockRejectedValue(new Error("storage unavailable"));
    await loadBackground();

    const listener = chromeState.onContextMenuClicked.addListener.mock
      .calls[0]?.[0] as (
      info: chrome.contextMenus.OnClickData,
      tab: chrome.tabs.Tab,
    ) => void;
    listener(
      {
        menuItemId: ACTION_ID,
        srcUrl: IMAGE_URL,
        frameId: 0,
      } as chrome.contextMenus.OnClickData,
      { id: TAB_ID, url: PAGE_URL, windowId: WINDOW_ID } as chrome.tabs.Tab,
    );
    await waitForCall(mocks.appendHistory, 1);
    await vi.waitFor(() =>
      expect(
        mocks.setWorkflowState.mock.calls.some(([state]) =>
          isErrorWorkflowState(state),
        ),
      ).toBe(true),
    );

    expect(mocks.createHistoryRecord).toHaveBeenCalledTimes(1);
    expect(mocks.appendHistory).toHaveBeenCalledTimes(1);
  });

  it("retains screenshot-fallback bytes for the manual download action", async () => {
    const chromeState = setupChrome();
    chromeState.setBadgeText.mockResolvedValue(undefined);
    const snapshot = {
      documentMarker: "marker-1",
      url: PAGE_URL,
      viewportWidth: 100,
      viewportHeight: 100,
      devicePixelRatio: 1,
      scrollX: 0,
      scrollY: 0,
      selection: {
        url: IMAGE_URL,
        tagName: "IMG",
        rect: { x: 0, y: 0, width: 10, height: 10 },
      },
    };
    let scriptCall = 0;
    chromeState.executeScript.mockImplementation(() => {
      scriptCall += 1;
      return scriptCall === 1
        ? [{ frameId: 0, documentId: DOCUMENT_ID }]
        : [{ frameId: 0, result: snapshot }];
    });
    chromeState.api.tabs.captureVisibleTab = vi
      .fn()
      .mockResolvedValue("data:image/png;base64,iVBORw0KGgo=");
    const nativeFetch = globalThis.fetch.bind(globalThis);
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      nativeFetch(input, init),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(() => ({
        width: 10,
        height: 10,
        close: vi.fn(),
      })),
    );
    class TestCanvas {
      public constructor(
        public readonly width: number,
        public readonly height: number,
      ) {}

      public getContext(): { drawImage: ReturnType<typeof vi.fn> } {
        return { drawImage: vi.fn() };
      }

      public convertToBlob(): Promise<Blob> {
        return Promise.resolve(
          new NodeBlob([IMAGE_BYTES], { type: "image/png" }) as unknown as Blob,
        );
      }
    }
    vi.stubGlobal("OffscreenCanvas", TestCanvas);
    mocks.actionHandler.mockResolvedValue({
      kind: "api",
      outcome: unavailableOutcome(),
    });
    mocks.verifyRetrievedImage.mockImplementation((image: unknown) => ({
      ...unavailableOutcome(),
      imageSha256: "b".repeat(64),
      retrieved: image,
      manualFallbackAvailable: true,
      screenshotFallbackAvailable: false,
    }));
    await loadBackground();

    const messageListener = chromeState.onMessage.addListener.mock
      .calls[0]?.[0] as (
      message: unknown,
      sender: chrome.runtime.MessageSender,
    ) => void;
    messageListener(
      { type: "start-action", actionId: ACTION_ID, trigger: "popup" },
      extensionPageSender("palette.html"),
    );
    await vi.waitFor(() =>
      expect(
        chromeState.sendMessage.mock.calls.some(
          ([, message]) =>
            (message as { type?: string })?.type === "picker-start",
        ),
      ).toBe(true),
    );
    const pickerStart = chromeState.sendMessage.mock.calls.find(
      ([, message]) => (message as { type?: string })?.type === "picker-start",
    )?.[1] as { sessionToken: string };
    expect(pickerStart.sessionToken).toMatch(/^[0-9a-f-]{36}$/u);

    messageListener(
      {
        type: "picker-selected",
        sessionToken: pickerStart.sessionToken,
        selection: selection(),
      },
      {
        tab: { id: TAB_ID },
        frameId: 0,
        documentId: DOCUMENT_ID,
      } as chrome.runtime.MessageSender,
    );
    await waitForCall(mocks.appendHistory, 1);
    messageListener(
      { type: "verify-screenshot", fallbackId: FIRST_RESULT_ID },
      extensionPageSender("details.html"),
    );
    await waitForCall(mocks.appendHistory, 2);
    // A screenshot copy is not the exact file, so its result offers no
    // Google SynthID check.
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "show-toast").at(-1)).toMatchObject({
        resultId: SECOND_RESULT_ID,
        actions: ["details"],
      }),
    );
    const fetchCall = fetchMock.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    expect(fetchCall[0]).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(fetchCall[1].credentials).toBe("omit");
    expect(fetchCall[1].signal).toBeInstanceOf(AbortSignal);

    messageListener(
      { type: "download-fallback", resultId: SECOND_RESULT_ID },
      extensionPageSender("details.html"),
    );
    await vi.waitFor(() =>
      expect(chromeState.api.downloads.download).toHaveBeenCalledTimes(1),
    );
    const download = chromeState.api.downloads.download as ReturnType<
      typeof vi.fn
    >;
    const downloadOptions = download.mock.calls[0]?.[0] as unknown as {
      url: string;
    };
    const downloadUrl = downloadOptions.url;
    expect(
      Uint8Array.from(
        atob(downloadUrl.slice(downloadUrl.indexOf(",") + 1)),
        (char) => char.charCodeAt(0),
      ),
    ).toEqual(IMAGE_BYTES);
  });

  function startPageLink(
    chromeState: ReturnType<typeof setupChrome>,
    options?: Record<string, unknown>,
  ): void {
    const messageListener = chromeState.onMessage.addListener.mock
      .calls[0]?.[0] as (
      message: unknown,
      sender: chrome.runtime.MessageSender,
    ) => void;
    messageListener(
      {
        type: "start-action",
        actionId: LINK_ACTION_ID,
        trigger: "popup",
        ...(options ? { options } : {}),
      },
      extensionPageSender("palette.html"),
    );
  }

  function pageLinkAction(): void {
    mocks.getActionDefinition.mockReturnValue({
      inputType: "page-link",
      handler: mocks.actionHandler,
    });
  }

  it("sends the active tab's address as a page link and clears the badge", async () => {
    const chromeState = setupChrome();
    chromeState.setBadgeText.mockResolvedValue(undefined);
    pageLinkAction();
    mocks.actionHandler.mockResolvedValue(undefined);
    await loadBackground();

    startPageLink(chromeState);

    await waitForCall(mocks.actionHandler, 1);
    expect(mocks.actionHandler).toHaveBeenCalledWith({ url: PAGE_URL }, {});
    await vi.waitFor(() =>
      expect(chromeState.setBadgeText).toHaveBeenCalledWith({
        tabId: TAB_ID,
        text: "",
      }),
    );
    expect(chromeState.setBadgeText).not.toHaveBeenCalledWith({
      tabId: TAB_ID,
      text: "!",
    });
  });

  it("shows the error badge when the page link is refused", async () => {
    const chromeState = setupChrome();
    chromeState.setBadgeText.mockResolvedValue(undefined);
    pageLinkAction();
    mocks.actionHandler.mockRejectedValue(new Error("job_limit"));
    await loadBackground();

    startPageLink(chromeState);

    await vi.waitFor(() =>
      expect(chromeState.setBadgeText).toHaveBeenCalledWith({
        tabId: TAB_ID,
        text: "!",
      }),
    );
    expect(chromeState.setBadgeText).not.toHaveBeenCalledWith({
      tabId: TAB_ID,
      text: "",
    });
  });

  it("ignores a second page-link start while one is in flight", async () => {
    const chromeState = setupChrome();
    chromeState.setBadgeText.mockResolvedValue(undefined);
    pageLinkAction();
    let finishSend: () => void = () => undefined;
    mocks.actionHandler.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishSend = resolve;
        }),
    );
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    await loadBackground();

    startPageLink(chromeState);
    await waitForCall(mocks.actionHandler, 1);
    startPageLink(chromeState);
    await flush();
    expect(mocks.actionHandler).toHaveBeenCalledTimes(1);

    finishSend();
    await vi.waitFor(() =>
      expect(chromeState.setBadgeText).toHaveBeenCalledWith({
        tabId: TAB_ID,
        text: "",
      }),
    );
    await flush();
    startPageLink(chromeState);
    await waitForCall(mocks.actionHandler, 2);
  });

  it("accepts a new page-link start after a rejected send", async () => {
    const chromeState = setupChrome();
    chromeState.setBadgeText.mockResolvedValue(undefined);
    pageLinkAction();
    mocks.actionHandler
      .mockRejectedValueOnce(new Error("job_limit"))
      .mockResolvedValueOnce(undefined);
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    await loadBackground();

    startPageLink(chromeState);
    await vi.waitFor(() =>
      expect(chromeState.setBadgeText).toHaveBeenCalledWith({
        tabId: TAB_ID,
        text: "!",
      }),
    );
    await flush();
    startPageLink(chromeState);

    await waitForCall(mocks.actionHandler, 2);
    await vi.waitFor(() =>
      expect(chromeState.setBadgeText).toHaveBeenCalledWith({
        tabId: TAB_ID,
        text: "",
      }),
    );
  });

  it("passes the palette's output or clip through to the page-link action", async () => {
    const chromeState = setupChrome();
    chromeState.setBadgeText.mockResolvedValue(undefined);
    pageLinkAction();
    mocks.actionHandler.mockResolvedValue(undefined);
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    await loadBackground();

    startPageLink(chromeState, { output: "mp3" });
    await waitForCall(mocks.actionHandler, 1);
    expect(mocks.actionHandler).toHaveBeenLastCalledWith(
      { url: PAGE_URL },
      { output: "mp3" },
    );
    await vi.waitFor(() =>
      expect(chromeState.setBadgeText).toHaveBeenCalledWith({
        tabId: TAB_ID,
        text: "",
      }),
    );
    await flush();

    startPageLink(chromeState, { startSeconds: 65, endSeconds: 120 });
    await waitForCall(mocks.actionHandler, 2);
    expect(mocks.actionHandler).toHaveBeenLastCalledWith(
      { url: PAGE_URL },
      { startSeconds: 65, endSeconds: 120 },
    );
  });

  it("drops a page-link start whose options are invalid", async () => {
    const chromeState = setupChrome();
    pageLinkAction();
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    await loadBackground();
    const actionLookups = mocks.getActionDefinition.mock.calls.length;

    for (const options of [
      { startSeconds: 65 },
      { startSeconds: 120, endSeconds: 65 },
      { output: "opus" },
      { output: "mp3", quality: "320k" },
    ])
      startPageLink(chromeState, options);
    await flush();
    await flush();

    expect(mocks.getActionDefinition).toHaveBeenCalledTimes(actionLookups);
    expect(mocks.actionHandler).not.toHaveBeenCalled();
    expect(chromeState.tabsQuery).not.toHaveBeenCalled();
  });

  const OTHER_SESSION_TOKEN = "323e4567-e89b-42d3-a456-426614174000";
  const PICKED_URL = "https://x.com/alice/status/123";

  function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  function messageListenerOf(chromeState: ReturnType<typeof setupChrome>) {
    return chromeState.onMessage.addListener.mock.calls[0]?.[0] as (
      message: unknown,
      sender: chrome.runtime.MessageSender,
    ) => void;
  }

  /** The bound picker document, or a sender that differs from it. */
  function pickerSender(
    overrides: Partial<chrome.runtime.MessageSender> = {},
  ): chrome.runtime.MessageSender {
    return {
      tab: { id: TAB_ID } as chrome.tabs.Tab,
      frameId: 0,
      documentId: DOCUMENT_ID,
      url: PAGE_URL,
      ...overrides,
    };
  }

  /** A connected browser whose active page accepts the picker script. */
  function connectedVideoPick(
    chromeState: ReturnType<typeof setupChrome>,
  ): void {
    chromeState.setBadgeText.mockResolvedValue(undefined);
    chromeState.executeScript.mockResolvedValue([
      { frameId: 0, documentId: DOCUMENT_ID },
    ]);
    mocks.isIntegrationConnected.mockResolvedValue(true);
    mocks.getActionDefinition.mockReturnValue({
      inputType: "video-pick",
      handler: mocks.actionHandler,
    });
  }

  /** Starts the video picker from the palette and returns its session token. */
  async function startVideoPick(
    chromeState: ReturnType<typeof setupChrome>,
    options?: Record<string, unknown>,
  ): Promise<string> {
    messageListenerOf(chromeState)(
      {
        type: "start-action",
        actionId: PICK_VIDEO_ACTION_ID,
        trigger: "popup",
        ...(options ? { options } : {}),
      },
      extensionPageSender("palette.html"),
    );
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "picker-start")).toHaveLength(1),
    );
    const start = tabMessages(chromeState, "picker-start")[0];
    expect(start).toMatchObject({ mode: "link", label: "send-video" });
    await vi.waitFor(() =>
      expect(mocks.setWorkflowState).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "picking",
          actionId: PICK_VIDEO_ACTION_ID,
        }),
      ),
    );
    return start?.["sessionToken"] as string;
  }

  it("sends a picked link with the palette's output and reports on the page", async () => {
    const chromeState = setupChrome();
    connectedVideoPick(chromeState);
    mocks.actionHandler.mockResolvedValue(undefined);
    await loadBackground();

    const sessionToken = await startVideoPick(chromeState, { output: "m4a" });
    messageListenerOf(chromeState)(
      { type: "picker-link-selected", sessionToken, url: PICKED_URL },
      pickerSender(),
    );

    await waitForCall(mocks.actionHandler, 1);
    expect(mocks.actionHandler).toHaveBeenCalledWith(
      { url: PICKED_URL },
      { output: "m4a" },
    );
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "show-toast")).toHaveLength(2),
    );
    expect(tabMessages(chromeState, "picker-stop")).toEqual([
      expect.objectContaining({ sessionToken }),
    ]);
    // A progress toast at once, then the result in its place.
    expect(tabMessages(chromeState, "show-toast")).toEqual([
      {
        type: "show-toast",
        runtimeVersion: "0.9.0",
        sessionToken,
        tone: "progress",
        title: "Sending to DigiBot…",
        message: "x.com · Audio file",
        resultId: null,
      },
      {
        type: "show-toast",
        runtimeVersion: "0.9.0",
        sessionToken,
        tone: "success",
        title: "Sent to DigiBot",
        message: "Queued in DigiBot. The result arrives in your Telegram chat.",
        resultId: null,
      },
    ]);
    const toastCall = chromeState.sendMessage.mock.calls.find(
      ([, message]) => (message as { type?: string }).type === "show-toast",
    );
    expect(toastCall?.[0]).toBe(TAB_ID);
    expect(toastCall?.[2]).toEqual({ documentId: DOCUMENT_ID });
    expect(chromeState.setBadgeText).toHaveBeenCalledWith({
      tabId: TAB_ID,
      text: "…",
    });
    expect(chromeState.setBadgeText).toHaveBeenLastCalledWith({
      tabId: TAB_ID,
      text: "",
    });
  });

  it("ignores a picked link from anything but the bound picker document", async () => {
    const chromeState = setupChrome();
    connectedVideoPick(chromeState);
    mocks.actionHandler.mockResolvedValue(undefined);
    await loadBackground();

    const sessionToken = await startVideoPick(chromeState);
    const listener = messageListenerOf(chromeState);
    const picked = {
      type: "picker-link-selected",
      sessionToken,
      url: PICKED_URL,
    };
    for (const sender of [
      pickerSender({ documentId: "document-2" }),
      pickerSender({ tab: { id: TAB_ID + 1 } as chrome.tabs.Tab }),
      pickerSender({ frameId: 3 }),
      extensionPageSender("palette.html"),
    ])
      listener(picked, sender);
    listener({ ...picked, sessionToken: OTHER_SESSION_TOKEN }, pickerSender());
    await flush();
    await flush();
    expect(mocks.actionHandler).not.toHaveBeenCalled();
    expect(tabMessages(chromeState, "picker-stop")).toHaveLength(0);

    listener(picked, pickerSender());
    await waitForCall(mocks.actionHandler, 1);
    expect(mocks.actionHandler).toHaveBeenCalledWith({ url: PICKED_URL }, {});
    expect(tabMessages(chromeState, "picker-stop")).toHaveLength(1);

    // A consumed token is spent, and an image session's token sends no link.
    listener(picked, pickerSender());
    mocks.getActionDefinition.mockImplementation((actionId: string) => ({
      inputType: actionId === ACTION_ID ? "image-file" : "video-pick",
      handler: mocks.actionHandler,
    }));
    listener(
      { type: "start-action", actionId: ACTION_ID, trigger: "popup" },
      extensionPageSender("palette.html"),
    );
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "picker-start")).toHaveLength(2),
    );
    const imageStart = tabMessages(chromeState, "picker-start")[1];
    expect(imageStart).not.toHaveProperty("mode");
    listener(
      { ...picked, sessionToken: imageStart?.["sessionToken"] },
      pickerSender(),
    );
    await flush();
    await flush();
    expect(mocks.actionHandler).toHaveBeenCalledTimes(1);
    expect(tabMessages(chromeState, "picker-stop")).toHaveLength(1);
  });

  /**
   * chrome.storage.session backed by one map, shared across worker restarts.
   * Like Chrome, a read returns a copy.
   */
  function sessionStorageOf(
    chromeState: ReturnType<typeof setupChrome>,
    store = new Map<string, unknown>(),
  ): Map<string, unknown> {
    chromeState.sessionGet.mockImplementation((key: string) =>
      Promise.resolve(
        store.has(key) ? { [key]: structuredClone(store.get(key)) } : {},
      ),
    );
    chromeState.sessionSet.mockImplementation(
      (values: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(values))
          store.set(key, value);
        return Promise.resolve();
      },
    );
    return store;
  }

  const LINK_PICKER_SESSIONS_KEY = "provenanceLens.linkPickerSessions";

  it("sends a persisted link pick once after the worker restarted", async () => {
    const firstWorker = setupChrome();
    const store = sessionStorageOf(firstWorker);
    connectedVideoPick(firstWorker);
    await loadBackground();
    const sessionToken = await startVideoPick(firstWorker, { output: "mp3" });
    const activityId = recent.entries[0]?.id;
    expect(store.get(LINK_PICKER_SESSIONS_KEY)).toEqual({
      [sessionToken]: {
        sessionToken,
        tabId: TAB_ID,
        frameId: 0,
        documentId: DOCUMENT_ID,
        activityId,
        mode: "link",
        options: { output: "mp3" },
      },
    });

    // A fresh module has an empty session map; only storage remembers the pick.
    vi.resetModules();
    const restarted = setupChrome();
    sessionStorageOf(restarted, store);
    connectedVideoPick(restarted);
    mocks.actionHandler.mockResolvedValue(undefined);
    await loadBackground();
    const listener = messageListenerOf(restarted);
    const picked = {
      type: "picker-link-selected",
      sessionToken,
      url: PICKED_URL,
    };
    listener(picked, pickerSender());

    await waitForCall(mocks.actionHandler, 1);
    expect(mocks.actionHandler).toHaveBeenCalledWith(
      { url: PICKED_URL },
      { output: "mp3" },
    );
    await vi.waitFor(() =>
      expect(tabMessages(restarted, "show-toast")).toHaveLength(2),
    );
    expect(tabMessages(restarted, "show-toast")[1]).toMatchObject({
      sessionToken,
      tone: "success",
      title: "Sent to DigiBot",
    });
    expect(tabMessages(restarted, "picker-stop")).toHaveLength(1);
    expect(store.get(LINK_PICKER_SESSIONS_KEY)).toEqual({});
    // The restarted worker ends the entry the first one started.
    expect(recent.entries).toEqual([
      expect.objectContaining({
        id: activityId,
        kind: "audio-file",
        linkUrl: PICKED_URL,
        state: "sent",
      }),
    ]);

    // Consumed: a replay, even after another restart, sends nothing more.
    listener(picked, pickerSender());
    await flush();
    await flush();
    vi.resetModules();
    const replayed = setupChrome();
    sessionStorageOf(replayed, store);
    connectedVideoPick(replayed);
    await loadBackground();
    messageListenerOf(replayed)(picked, pickerSender());
    await flush();
    await flush();
    expect(mocks.actionHandler).toHaveBeenCalledTimes(1);
    expect(tabMessages(replayed, "picker-stop")).toHaveLength(0);
  });

  it("drops a persisted link pick that was cancelled or stopped", async () => {
    const firstWorker = setupChrome();
    const store = sessionStorageOf(firstWorker);
    connectedVideoPick(firstWorker);
    await loadBackground();
    const cancelled = await startVideoPick(firstWorker);

    vi.resetModules();
    const restarted = setupChrome();
    sessionStorageOf(restarted, store);
    connectedVideoPick(restarted);
    mocks.actionHandler.mockResolvedValue(undefined);
    await loadBackground();
    const listener = messageListenerOf(restarted);
    listener(
      { type: "picker-cancelled", sessionToken: cancelled },
      pickerSender(),
    );
    await vi.waitFor(() =>
      expect(mocks.setWorkflowState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: "idle",
          message: "Video pick cancelled.",
        }),
      ),
    );
    expect(store.get(LINK_PICKER_SESSIONS_KEY)).toEqual({});
    listener(
      {
        type: "picker-link-selected",
        sessionToken: cancelled,
        url: PICKED_URL,
      },
      pickerSender(),
    );
    await flush();
    await flush();
    expect(mocks.actionHandler).not.toHaveBeenCalled();

    // A pick whose picker-start never reached the page leaves no record.
    restarted.sendMessage.mockImplementation(
      (_tabId: number, message: unknown) =>
        (message as { type?: string }).type === "picker-start"
          ? Promise.reject(new Error("no receiver"))
          : Promise.resolve(undefined),
    );
    listener(
      {
        type: "start-action",
        actionId: PICK_VIDEO_ACTION_ID,
        trigger: "popup",
      },
      extensionPageSender("palette.html"),
    );
    await vi.waitFor(() =>
      expect(mocks.setWorkflowState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: "error",
          message: "The video picker could not access this page.",
        }),
      ),
    );
    expect(store.get(LINK_PICKER_SESSIONS_KEY)).toEqual({});
  });

  it("stops a stored pick on the palette's Cancel pick after the worker restarted", async () => {
    const firstWorker = setupChrome();
    const store = sessionStorageOf(firstWorker);
    connectedVideoPick(firstWorker);
    await loadBackground();
    const sessionToken = await startVideoPick(firstWorker);
    const activityId = recent.entries[0]?.id;

    vi.resetModules();
    const restarted = setupChrome();
    sessionStorageOf(restarted, store);
    connectedVideoPick(restarted);
    await loadBackground();
    messageListenerOf(restarted)(
      { type: "cancel-active" },
      extensionPageSender("palette.html"),
    );
    await vi.waitFor(() =>
      expect(mocks.setWorkflowState).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "idle", message: "Pick cancelled." }),
      ),
    );
    expect(tabMessages(restarted, "picker-stop")).toEqual([
      expect.objectContaining({ sessionToken }),
    ]);
    expect(store.get(LINK_PICKER_SESSIONS_KEY)).toEqual({});
    expect(recent.entries).toEqual([
      expect.objectContaining({
        id: activityId,
        state: "cancelled",
        message: "Pick cancelled.",
      }),
    ]);
  });

  /** Starts more link picks one after another; returns their session tokens. */
  async function startVideoPicks(
    chromeState: ReturnType<typeof setupChrome>,
    count: number,
  ): Promise<string[]> {
    const listener = messageListenerOf(chromeState);
    const before = tabMessages(chromeState, "picker-start").length;
    for (let started = 1; started <= count; started += 1) {
      listener(
        {
          type: "start-action",
          actionId: PICK_VIDEO_ACTION_ID,
          trigger: "popup",
        },
        extensionPageSender("palette.html"),
      );
      await vi.waitFor(() =>
        expect(tabMessages(chromeState, "picker-start")).toHaveLength(
          before + started,
        ),
      );
    }
    return tabMessages(chromeState, "picker-start")
      .slice(before)
      .map((message) => message["sessionToken"] as string);
  }

  it("keeps the last eight stored link picks and evicts the oldest", async () => {
    const chromeState = setupChrome();
    const store = sessionStorageOf(chromeState);
    connectedVideoPick(chromeState);
    await loadBackground();

    const tokens = await startVideoPicks(chromeState, 9);
    expect(new Set(tokens).size).toBe(9);
    const stored = store.get(LINK_PICKER_SESSIONS_KEY) as Record<
      string,
      unknown
    >;
    expect(Object.keys(stored)).toEqual(tokens.slice(1));
    expect(stored[tokens[8] ?? ""]).toEqual({
      sessionToken: tokens[8],
      tabId: TAB_ID,
      frameId: 0,
      documentId: DOCUMENT_ID,
      activityId: recent.entries[0]?.id,
      mode: "link",
      options: {},
    });

    // After a restart the evicted pick is gone while the newest still sends.
    vi.resetModules();
    const restarted = setupChrome();
    sessionStorageOf(restarted, store);
    connectedVideoPick(restarted);
    mocks.actionHandler.mockResolvedValue(undefined);
    await loadBackground();
    const listener = messageListenerOf(restarted);
    listener(
      {
        type: "picker-link-selected",
        sessionToken: tokens[0],
        url: PICKED_URL,
      },
      pickerSender(),
    );
    await flush();
    await flush();
    expect(mocks.actionHandler).not.toHaveBeenCalled();
    listener(
      {
        type: "picker-link-selected",
        sessionToken: tokens[8],
        url: PICKED_URL,
      },
      pickerSender(),
    );
    await waitForCall(mocks.actionHandler, 1);
    expect(tabMessages(restarted, "picker-stop")).toHaveLength(1);
  });

  const CANCELLED_STATE: unknown = expect.objectContaining({
    status: "idle",
    message: "Video pick cancelled.",
  });

  /** Picks the started session once and waits for the page notice. */
  async function pickOnce(
    chromeState: ReturnType<typeof setupChrome>,
    sessionToken: string,
    ...sameTick: Array<Record<string, unknown>>
  ): Promise<void> {
    const listener = messageListenerOf(chromeState);
    listener(
      { type: "picker-link-selected", sessionToken, url: PICKED_URL },
      pickerSender(),
    );
    for (const message of sameTick) listener(message, pickerSender());
    await waitForCall(mocks.actionHandler, 1);
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "show-toast")).toHaveLength(2),
    );
    await flush();
    await flush();
  }

  it("sends once when two picked-link messages arrive in the same tick", async () => {
    const chromeState = setupChrome();
    connectedVideoPick(chromeState);
    mocks.actionHandler.mockResolvedValue(undefined);
    await loadBackground();
    const sessionToken = await startVideoPick(chromeState);

    await pickOnce(chromeState, sessionToken, {
      type: "picker-link-selected",
      sessionToken,
      url: PICKED_URL,
    });
    expect(mocks.actionHandler).toHaveBeenCalledTimes(1);
    expect(tabMessages(chromeState, "picker-stop")).toHaveLength(1);
    expect(tabMessages(chromeState, "show-toast")).toEqual([
      expect.objectContaining({ title: "Sending to DigiBot…" }),
      expect.objectContaining({ title: "Sent to DigiBot" }),
    ]);
  });

  it("keeps a pick that a cancel in the same tick tries to undo", async () => {
    const chromeState = setupChrome();
    connectedVideoPick(chromeState);
    mocks.actionHandler.mockResolvedValue(undefined);
    await loadBackground();
    const sessionToken = await startVideoPick(chromeState);

    await pickOnce(chromeState, sessionToken, {
      type: "picker-cancelled",
      sessionToken,
    });
    expect(mocks.actionHandler).toHaveBeenCalledTimes(1);
    expect(tabMessages(chromeState, "picker-stop")).toHaveLength(1);
    expect(mocks.setWorkflowState).not.toHaveBeenCalledWith(CANCELLED_STATE);
  });

  it("refuses a spent token whose stored record came back", async () => {
    const chromeState = setupChrome();
    const store = sessionStorageOf(chromeState);
    connectedVideoPick(chromeState);
    mocks.actionHandler.mockResolvedValue(undefined);
    await loadBackground();
    const sessionToken = await startVideoPick(chromeState);
    const record = {
      [sessionToken]: {
        sessionToken,
        tabId: TAB_ID,
        frameId: 0,
        documentId: DOCUMENT_ID,
        activityId: recent.entries[0]?.id,
        mode: "link",
        options: {},
      },
    };
    expect(store.get(LINK_PICKER_SESSIONS_KEY)).toEqual(record);

    await pickOnce(chromeState, sessionToken);
    expect(store.get(LINK_PICKER_SESSIONS_KEY)).toEqual({});
    // A record that outlived its pick restores a session; the token is spent.
    store.set(LINK_PICKER_SESSIONS_KEY, record);
    const listener = messageListenerOf(chromeState);
    listener(
      { type: "picker-link-selected", sessionToken, url: PICKED_URL },
      pickerSender(),
    );
    listener({ type: "picker-cancelled", sessionToken }, pickerSender());
    await flush();
    await flush();
    await flush();
    expect(mocks.actionHandler).toHaveBeenCalledTimes(1);
    expect(tabMessages(chromeState, "picker-stop")).toHaveLength(1);
    // Only the first pick's progress and result toasts.
    expect(tabMessages(chromeState, "show-toast")).toHaveLength(2);
    expect(mocks.setWorkflowState).not.toHaveBeenCalledWith(CANCELLED_STATE);
    expect(store.get(LINK_PICKER_SESSIONS_KEY)).toEqual(record);
  });

  it("refuses a picked X address that is not a post", async () => {
    const chromeState = setupChrome();
    connectedVideoPick(chromeState);
    await loadBackground();

    const sessionToken = await startVideoPick(chromeState);
    messageListenerOf(chromeState)(
      {
        type: "picker-link-selected",
        sessionToken,
        url: "https://x.com/home",
      },
      pickerSender(),
    );

    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "show-toast")).toHaveLength(1),
    );
    expect(tabMessages(chromeState, "show-toast")[0]).toMatchObject({
      tone: "error",
      title: "Page link not sent",
      message:
        "That link cannot be sent to Telegram. Pick a post that shows a video, a YouTube video or a page link.",
    });
    expect(mocks.actionHandler).not.toHaveBeenCalled();
    expect(tabMessages(chromeState, "picker-stop")).toHaveLength(1);
    expect(mocks.setWorkflowState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "error",
        actionId: PICK_VIDEO_ACTION_ID,
      }),
    );
    expect(chromeState.setBadgeText).toHaveBeenCalledWith({
      tabId: TAB_ID,
      text: "!",
    });
  });

  it("refuses a picked link while another page link is still being sent", async () => {
    const chromeState = setupChrome();
    connectedVideoPick(chromeState);
    let finishSend: () => void = () => undefined;
    mocks.actionHandler.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSend = resolve;
        }),
    );
    await loadBackground();
    mocks.getActionDefinition.mockReturnValueOnce({
      inputType: "page-link",
      handler: mocks.actionHandler,
    });

    startPageLink(chromeState);
    await waitForCall(mocks.actionHandler, 1);
    const sessionToken = await startVideoPick(chromeState);
    messageListenerOf(chromeState)(
      { type: "picker-link-selected", sessionToken, url: PICKED_URL },
      pickerSender(),
    );

    // The palette's page link reports on its own page too; the refused pick
    // reports on the picker's page, with no button.
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "show-toast")).toContainEqual(
        expect.objectContaining({ title: "Page link not sent" }),
      ),
    );
    expect(
      tabMessages(chromeState, "show-toast").find(
        (toast) => toast["title"] === "Page link not sent",
      ),
    ).toEqual({
      type: "show-toast",
      runtimeVersion: "0.9.0",
      sessionToken,
      tone: "error",
      title: "Page link not sent",
      message: "Another page link is still being sent.",
      resultId: null,
    });
    expect(mocks.actionHandler).toHaveBeenCalledTimes(1);
    finishSend();
    await vi.waitFor(() =>
      expect(chromeState.setBadgeText).toHaveBeenCalledWith({
        tabId: TAB_ID,
        text: "",
      }),
    );
  });

  it("clears the video pick when the picker is cancelled", async () => {
    const chromeState = setupChrome();
    connectedVideoPick(chromeState);
    await loadBackground();

    const sessionToken = await startVideoPick(chromeState);
    const listener = messageListenerOf(chromeState);
    listener({ type: "picker-cancelled", sessionToken }, pickerSender());
    await vi.waitFor(() =>
      expect(mocks.setWorkflowState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: "idle",
          actionId: null,
          message: "Video pick cancelled.",
        }),
      ),
    );
    expect(tabMessages(chromeState, "picker-stop")).toHaveLength(1);
    expect(chromeState.setBadgeText).toHaveBeenCalledWith({
      tabId: TAB_ID,
      text: "",
    });

    // The session is spent: a late pick from the same document is ignored.
    listener(
      { type: "picker-link-selected", sessionToken, url: PICKED_URL },
      pickerSender(),
    );
    await flush();
    await flush();
    expect(mocks.actionHandler).not.toHaveBeenCalled();
  });

  it("does not open the video picker until DigiBot is connected", async () => {
    const chromeState = setupChrome();
    connectedVideoPick(chromeState);
    mocks.isIntegrationConnected.mockResolvedValue(false);
    await loadBackground();

    messageListenerOf(chromeState)(
      {
        type: "start-action",
        actionId: PICK_VIDEO_ACTION_ID,
        trigger: "popup",
      },
      extensionPageSender("palette.html"),
    );
    await vi.waitFor(() =>
      expect(mocks.setWorkflowState).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "error",
          message:
            "Connect Provenance Lens to DigiBot in Settings before picking a video.",
        }),
      ),
    );
    expect(chromeState.executeScript).not.toHaveBeenCalled();
    expect(chromeState.sendMessage).not.toHaveBeenCalled();
    expect(chromeState.setBadgeText).toHaveBeenCalledWith({
      tabId: TAB_ID,
      text: "!",
    });
  });

  it("does not open the video picker on a protected page", async () => {
    const chromeState = setupChrome();
    connectedVideoPick(chromeState);
    chromeState.tabsQuery.mockResolvedValue([
      { id: TAB_ID, url: "chrome://extensions/", windowId: WINDOW_ID },
    ]);
    await loadBackground();

    messageListenerOf(chromeState)(
      {
        type: "start-action",
        actionId: PICK_VIDEO_ACTION_ID,
        trigger: "popup",
      },
      extensionPageSender("palette.html"),
    );
    await vi.waitFor(() =>
      expect(mocks.setWorkflowState).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "error",
          message: "Video picking is not supported on this browser page.",
        }),
      ),
    );
    expect(chromeState.executeScript).not.toHaveBeenCalled();
    expect(mocks.isIntegrationConnected).not.toHaveBeenCalled();
  });

  /** Starts the download pick from the palette and returns its token. */
  async function startMediaPick(
    chromeState: ReturnType<typeof setupChrome>,
    nth = 1,
  ): Promise<string> {
    messageListenerOf(chromeState)(
      { type: "start-action", actionId: DOWNLOAD_ACTION_ID, trigger: "popup" },
      extensionPageSender("palette.html"),
    );
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "picker-start")).toHaveLength(nth),
    );
    const start = tabMessages(chromeState, "picker-start")[nth - 1];
    expect(start).toMatchObject({ mode: "media", label: "send-media" });
    await vi.waitFor(() =>
      expect(mocks.setWorkflowState).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: "picking",
          actionId: DOWNLOAD_ACTION_ID,
          message: "Click an image or a video to send it to Telegram.",
        }),
      ),
    );
    return start?.["sessionToken"] as string;
  }

  /** The two link handlers a download pick can become, by action. */
  function mediaPickActions(): {
    video: ReturnType<typeof vi.fn>;
    page: ReturnType<typeof vi.fn>;
  } {
    const sent = {
      video: vi.fn().mockResolvedValue(undefined),
      page: vi.fn().mockResolvedValue(undefined),
    };
    mocks.getActionDefinition.mockImplementation((actionId: string) =>
      actionId === PICK_VIDEO_ACTION_ID
        ? { inputType: "video-pick", handler: sent.video }
        : actionId === LINK_ACTION_ID
          ? { inputType: "page-link", handler: sent.page }
          : { inputType: "image-file", handler: mocks.actionHandler },
    );
    return sent;
  }

  it("runs a download pick's image as the image download", async () => {
    const chromeState = setupChrome();
    sessionStorageOf(chromeState);
    connectedVideoPick(chromeState);
    const sent = mediaPickActions();
    const { ExtensionWorkflowError } =
      await import("../../src/actions/verify-openai-provenance.js");
    mocks.runIntegratedImageAction.mockRejectedValue(
      new ExtensionWorkflowError("user_cancelled", "Stopped."),
    );
    await loadBackground();

    const sessionToken = await startMediaPick(chromeState);
    const listener = messageListenerOf(chromeState);
    // Three answers in the same tick: the first one is taken, once.
    const picked = {
      type: "picker-selected",
      sessionToken,
      selection: selection(),
    };
    listener(picked, pickerSender());
    listener(picked, pickerSender());
    listener(
      { type: "picker-link-selected", sessionToken, url: PICKED_URL },
      pickerSender(),
    );
    await waitForCall(mocks.runIntegratedImageAction, 1);
    await flush();
    await flush();
    expect(mocks.runIntegratedImageAction).toHaveBeenCalledTimes(1);
    expect(mocks.runIntegratedImageAction.mock.calls[0]?.[0]).toBe("download");
    expect(mocks.runIntegratedImageAction.mock.calls[0]?.[1]).toMatchObject({
      url: IMAGE_URL,
    });
    expect(tabMessages(chromeState, "picker-stop")).toHaveLength(1);
    expect(sent.video).not.toHaveBeenCalled();
    expect(sent.page).not.toHaveBeenCalled();
  });

  it("sends a download pick's X video as the video pick, keeping /video/<n>", async () => {
    const chromeState = setupChrome();
    connectedVideoPick(chromeState);
    const sent = mediaPickActions();
    await loadBackground();

    const sessionToken = await startMediaPick(chromeState);
    messageListenerOf(chromeState)(
      {
        type: "picker-link-selected",
        sessionToken,
        url: "https://x.com/alice/status/123/video/3",
      },
      pickerSender(),
    );
    await waitForCall(sent.video, 1);
    expect(sent.video).toHaveBeenCalledWith(
      { url: "https://x.com/alice/status/123/video/3" },
      {},
    );
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "show-toast")).toHaveLength(2),
    );
    expect(tabMessages(chromeState, "show-toast")[0]).toMatchObject({
      sessionToken,
      tone: "progress",
      message: "x.com · Video",
    });
    expect(mocks.runIntegratedImageAction).not.toHaveBeenCalled();
    expect(sent.page).not.toHaveBeenCalled();
  });

  it("sends the tab's own address for a video with no link, and refuses a listing page", async () => {
    const chromeState = setupChrome();
    connectedVideoPick(chromeState);
    const sent = mediaPickActions();
    const getTab = chromeState.api.tabs.get as ReturnType<typeof vi.fn>;
    getTab.mockResolvedValue({ id: TAB_ID, url: "https://news.example/story" });
    await loadBackground();
    const listener = messageListenerOf(chromeState);

    const first = await startMediaPick(chromeState);
    // Only the bound picker document may answer.
    listener(
      { type: "picker-page-selected", sessionToken: first },
      pickerSender({ documentId: "document-2" }),
    );
    listener(
      { type: "picker-page-selected", sessionToken: first },
      pickerSender(),
    );
    await waitForCall(sent.page, 1);
    expect(sent.page).toHaveBeenCalledWith(
      { url: "https://news.example/story" },
      {},
    );
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "show-toast")).toHaveLength(2),
    );

    getTab.mockResolvedValue({ id: TAB_ID, url: "https://x.com/home" });
    const second = await startMediaPick(chromeState, 2);
    listener(
      { type: "picker-page-selected", sessionToken: second },
      pickerSender(),
    );
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "show-toast")).toHaveLength(3),
    );
    expect(tabMessages(chromeState, "show-toast")[2]).toMatchObject({
      sessionToken: second,
      tone: "error",
      title: "Page link not sent",
      message: "Open the video's own page, then pick it.",
    });
    expect(sent.page).toHaveBeenCalledTimes(1);
    expect(sent.video).not.toHaveBeenCalled();
    expect(chromeState.setBadgeText).toHaveBeenLastCalledWith({
      tabId: TAB_ID,
      text: "!",
    });

    // Without the tab's address, as when the page's grant has lapsed.
    getTab.mockResolvedValue({ id: TAB_ID });
    const third = await startMediaPick(chromeState, 3);
    listener(
      { type: "picker-page-selected", sessionToken: third },
      pickerSender(),
    );
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "show-toast")).toHaveLength(4),
    );
    expect(tabMessages(chromeState, "show-toast")[3]).toMatchObject({
      sessionToken: third,
      tone: "error",
      message:
        "Lens cannot read this tab's address. Reload the page, then pick again.",
    });
    expect(sent.page).toHaveBeenCalledTimes(1);
  });

  it("takes a stored download pick once after the worker restarted", async () => {
    const firstWorker = setupChrome();
    const store = sessionStorageOf(firstWorker);
    connectedVideoPick(firstWorker);
    mediaPickActions();
    await loadBackground();
    const sessionToken = await startMediaPick(firstWorker);
    expect(store.get(LINK_PICKER_SESSIONS_KEY)).toEqual({
      [sessionToken]: {
        sessionToken,
        tabId: TAB_ID,
        frameId: 0,
        documentId: DOCUMENT_ID,
        activityId: recent.entries[0]?.id,
        mode: "media",
        trigger: "popup",
        verificationMode: "api",
      },
    });

    vi.resetModules();
    const restarted = setupChrome();
    sessionStorageOf(restarted, store);
    connectedVideoPick(restarted);
    const sent = mediaPickActions();
    await loadBackground();
    const picked = {
      type: "picker-link-selected",
      sessionToken,
      url: "https://www.youtube.com/watch?v=abcdefghijk",
    };
    messageListenerOf(restarted)(picked, pickerSender());
    await waitForCall(sent.video, 1);
    expect(sent.video).toHaveBeenCalledWith(
      { url: "https://www.youtube.com/watch?v=abcdefghijk" },
      {},
    );
    expect(store.get(LINK_PICKER_SESSIONS_KEY)).toEqual({});
    messageListenerOf(restarted)(picked, pickerSender());
    messageListenerOf(restarted)(
      { type: "picker-selected", sessionToken, selection: selection() },
      pickerSender(),
    );
    await flush();
    await flush();
    expect(sent.video).toHaveBeenCalledTimes(1);
    expect(mocks.runIntegratedImageAction).not.toHaveBeenCalled();
  });

  it("cancels a download pick and spends it", async () => {
    const chromeState = setupChrome();
    connectedVideoPick(chromeState);
    const sent = mediaPickActions();
    await loadBackground();

    const sessionToken = await startMediaPick(chromeState);
    const listener = messageListenerOf(chromeState);
    listener({ type: "picker-cancelled", sessionToken }, pickerSender());
    await vi.waitFor(() =>
      expect(mocks.setWorkflowState).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "idle", message: "Pick cancelled." }),
      ),
    );
    for (const message of [
      { type: "picker-selected", sessionToken, selection: selection() },
      { type: "picker-link-selected", sessionToken, url: PICKED_URL },
      { type: "picker-page-selected", sessionToken },
    ])
      listener(message, pickerSender());
    await flush();
    await flush();
    expect(mocks.runIntegratedImageAction).not.toHaveBeenCalled();
    expect(sent.video).not.toHaveBeenCalled();
    expect(sent.page).not.toHaveBeenCalled();
  });

  it("does not open the download pick until DigiBot is connected", async () => {
    const chromeState = setupChrome();
    connectedVideoPick(chromeState);
    mediaPickActions();
    mocks.isIntegrationConnected.mockResolvedValue(false);
    await loadBackground();

    messageListenerOf(chromeState)(
      { type: "start-action", actionId: DOWNLOAD_ACTION_ID, trigger: "popup" },
      extensionPageSender("palette.html"),
    );
    await vi.waitFor(() =>
      expect(mocks.setWorkflowState).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "error",
          message:
            "Connect Provenance Lens to DigiBot in Settings before picking an image or a video.",
        }),
      ),
    );
    expect(chromeState.executeScript).not.toHaveBeenCalled();
  });

  it("accepts verification control messages only from the extension's own pages", async () => {
    const chromeState = setupChrome();
    await loadBackground();
    const messageListener = chromeState.onMessage.addListener.mock
      .calls[0]?.[0] as (
      message: unknown,
      sender: chrome.runtime.MessageSender,
    ) => void;
    const pendingDisclosuresKey = "provenanceLens.pendingDisclosures";
    const disclosureReads = () =>
      chromeState.sessionGet.mock.calls.filter(
        ([key]) => key === pendingDisclosuresKey,
      ).length;
    const tabQueries = chromeState.tabsQuery;
    const baseline = {
      actions: mocks.getActionDefinition.mock.calls.length,
      disclosureReads: disclosureReads(),
      tabQueries: tabQueries.mock.calls.length,
    };
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const controlMessages = [
      { type: "start-action", actionId: ACTION_ID, trigger: "popup" },
      { type: "start-action", actionId: LINK_ACTION_ID, trigger: "popup" },
      {
        type: "start-action",
        actionId: LINK_ACTION_ID,
        trigger: "popup",
        options: { output: "mp3" },
      },
      {
        type: "start-action",
        actionId: LINK_ACTION_ID,
        trigger: "popup",
        options: { startSeconds: 65, endSeconds: 120 },
      },
      {
        type: "start-action",
        actionId: PICK_VIDEO_ACTION_ID,
        trigger: "popup",
        options: { output: "mp3" },
      },
      { type: "start-action", actionId: SYNTHID_ACTION_ID, trigger: "popup" },
      {
        type: "resume-permission",
        pendingId: FIRST_RESULT_ID,
        verificationMode: "api",
      },
      {
        type: "resume-permission",
        pendingId: FIRST_RESULT_ID,
        verificationMode: "synthid",
      },
      { type: "verify-screenshot", fallbackId: FIRST_RESULT_ID },
      { type: "download-fallback", resultId: SECOND_RESULT_ID },
      { type: "cancel-active" },
    ];
    const untrustedSenders: chrome.runtime.MessageSender[] = [
      {},
      {
        tab: { id: TAB_ID } as chrome.tabs.Tab,
        frameId: 0,
        documentId: DOCUMENT_ID,
        url: PAGE_URL,
      },
      { url: `${PAGE_URL}chrome-extension://test/palette.html` },
      { url: "chrome-extension://other/palette.html" },
    ];

    for (const sender of untrustedSenders)
      for (const message of controlMessages) messageListener(message, sender);
    await flush();
    await flush();

    expect(mocks.getActionDefinition).toHaveBeenCalledTimes(baseline.actions);
    expect(disclosureReads()).toBe(baseline.disclosureReads);
    expect(tabQueries).toHaveBeenCalledTimes(baseline.tabQueries);
    expect(
      mocks.setWorkflowState.mock.calls.some(([state]) =>
        isErrorWorkflowState(state),
      ),
    ).toBe(false);
    expect(chromeState.api.downloads.download).not.toHaveBeenCalled();
    expect(chromeState.sendMessage).not.toHaveBeenCalled();

    messageListener(
      { type: "cancel-active" },
      extensionPageSender("palette.html"),
    );
    messageListener(
      {
        type: "resume-permission",
        pendingId: FIRST_RESULT_ID,
        verificationMode: "api",
      },
      extensionPageSender("disclosure.html"),
    );
    await vi.waitFor(() => {
      expect(tabQueries).toHaveBeenCalledTimes(baseline.tabQueries + 1);
      expect(disclosureReads()).toBe(baseline.disclosureReads + 1);
    });
  });

  const TOAST_BINDINGS_KEY = "provenanceLens.resultToastBindings";

  /** A page whose frame 0 accepts the picker script, with real session storage. */
  function boundPage(chromeState: ReturnType<typeof setupChrome>) {
    chromeState.setBadgeText.mockResolvedValue(undefined);
    chromeState.executeScript.mockResolvedValue([
      { frameId: 0, documentId: DOCUMENT_ID },
    ]);
    return sessionStorageOf(chromeState);
  }

  function boundToken(chromeState: ReturnType<typeof setupChrome>): string {
    return tabMessages(chromeState, "page-bind").at(-1)?.[
      "sessionToken"
    ] as string;
  }

  function contextMenuVerify(chromeState: ReturnType<typeof setupChrome>) {
    const listener = chromeState.onContextMenuClicked.addListener.mock
      .calls[0]?.[0] as (
      info: chrome.contextMenus.OnClickData,
      tab: chrome.tabs.Tab,
    ) => void;
    listener(
      {
        menuItemId: ACTION_ID,
        srcUrl: IMAGE_URL,
        frameId: 0,
      } as chrome.contextMenus.OnClickData,
      { id: TAB_ID, url: PAGE_URL, windowId: WINDOW_ID } as chrome.tabs.Tab,
    );
  }

  function websiteHandoff() {
    return {
      kind: "website",
      status: "opened",
      message:
        "The exact image was saved. Upload it on Google's SynthID Detector in the new tab.",
      toastMessage: "Upload it on Google's SynthID Detector in the new tab.",
    };
  }

  it("reports a palette page link on its page and retries it once from that page", async () => {
    const chromeState = setupChrome();
    const store = boundPage(chromeState);
    pageLinkAction();
    mocks.actionHandler
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(undefined);
    await loadBackground();

    startPageLink(chromeState, { output: "m4a" });
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "show-toast")).toHaveLength(2),
    );
    const sessionToken = boundToken(chromeState);
    expect(tabMessages(chromeState, "show-toast")).toEqual([
      expect.objectContaining({
        sessionToken,
        tone: "progress",
        title: "Sending to DigiBot…",
        message: "page.example · Audio file",
      }),
      expect.objectContaining({
        sessionToken,
        tone: "error",
        title: "Page link not sent",
        message: "The page link could not be sent to DigiBot.",
        actions: ["retry"],
      }),
    ]);
    expect(store.get(TOAST_BINDINGS_KEY)).toEqual([
      {
        resultId: null,
        sessionToken,
        tabId: TAB_ID,
        frameId: 0,
        documentId: DOCUMENT_ID,
        actions: ["retry"],
        retry: {
          actionId: LINK_ACTION_ID,
          url: PAGE_URL,
          options: { output: "m4a" },
        },
      },
    ]);

    const retry = { type: "toast-action", sessionToken, action: "retry" };
    messageListenerOf(chromeState)(
      retry,
      pickerSender({ documentId: "navigated-document" }),
    );
    await flush();
    await flush();
    expect(mocks.actionHandler).toHaveBeenCalledTimes(1);

    messageListenerOf(chromeState)(retry, pickerSender());
    await waitForCall(mocks.actionHandler, 2);
    expect(mocks.actionHandler).toHaveBeenLastCalledWith(
      { url: PAGE_URL },
      { output: "m4a" },
    );
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "show-toast").at(-1)).toMatchObject({
        tone: "success",
        title: "Sent to DigiBot",
      }),
    );
    // Retry acts once: the success toast has no buttons left to accept.
    messageListenerOf(chromeState)(retry, pickerSender());
    await flush();
    await flush();
    expect(mocks.actionHandler).toHaveBeenCalledTimes(2);
  });

  it("offers Connect DigiBot when a page link needs the connection", async () => {
    const chromeState = setupChrome();
    boundPage(chromeState);
    pageLinkAction();
    await loadBackground();
    // The class the freshly loaded worker checks against.
    const { PageLinkError } =
      await import("../../src/actions/integration-link.js");
    mocks.actionHandler.mockRejectedValue(
      new PageLinkError(
        "Connect Provenance Lens to DigiBot before sending a page link.",
        true,
      ),
    );

    startPageLink(chromeState);
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "show-toast").at(-1)).toMatchObject({
        tone: "error",
        actions: ["connect-digibot"],
      }),
    );
    messageListenerOf(chromeState)(
      {
        type: "toast-action",
        sessionToken: boundToken(chromeState),
        action: "connect-digibot",
      },
      pickerSender(),
    );
    await vi.waitFor(() =>
      expect(chromeState.api.tabs.create).toHaveBeenCalledWith({
        url: "chrome-extension://test/settings.html#integration-heading",
      }),
    );
  });

  it("shows a progress toast with Cancel while an image verifies, and Cancel stops it", async () => {
    const chromeState = setupChrome();
    boundPage(chromeState);
    mocks.actionHandler.mockImplementation(
      ({ retrieval }: { retrieval: { signal: AbortSignal } }) =>
        new Promise((resolve) => {
          retrieval.signal.addEventListener("abort", () =>
            resolve({
              kind: "api",
              outcome: { ...unavailableOutcome(), errorCode: "user_cancelled" },
            }),
          );
        }),
    );
    await loadBackground();

    contextMenuVerify(chromeState);
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "show-toast")).toHaveLength(1),
    );
    const sessionToken = boundToken(chromeState);
    expect(tabMessages(chromeState, "show-toast")[0]).toEqual({
      type: "show-toast",
      runtimeVersion: "0.9.0",
      sessionToken,
      tone: "progress",
      title: "Verifying image…",
      message: "page.example · API check",
      resultId: null,
      actions: ["cancel"],
    });
    expect(chromeState.setBadgeText).toHaveBeenCalledWith({
      tabId: TAB_ID,
      text: "…",
    });

    messageListenerOf(chromeState)(
      { type: "toast-action", sessionToken, action: "cancel" },
      pickerSender(),
    );
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "hide-toast")).toEqual([
        { type: "hide-toast", runtimeVersion: "0.9.0", sessionToken },
      ]),
    );
    expect(tabMessages(chromeState, "show-toast")).toHaveLength(1);
  });

  it("keeps a page-link Retry when a verify that ran before it on the page stops", async () => {
    const chromeState = setupChrome();
    const store = boundPage(chromeState);
    const sendLink = vi.fn().mockRejectedValue(new Error("network down"));
    mocks.getActionDefinition.mockImplementation((actionId: string) =>
      actionId === LINK_ACTION_ID
        ? { inputType: "page-link", handler: sendLink }
        : { inputType: "image-file", handler: mocks.actionHandler },
    );
    mocks.actionHandler.mockImplementation(
      ({ retrieval }: { retrieval: { signal: AbortSignal } }) =>
        new Promise((resolve) => {
          retrieval.signal.addEventListener("abort", () =>
            resolve({
              kind: "api",
              outcome: { ...unavailableOutcome(), errorCode: "user_cancelled" },
            }),
          );
        }),
    );
    await loadBackground();

    contextMenuVerify(chromeState);
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "show-toast")).toHaveLength(1),
    );
    const verifyToken = boundToken(chromeState);
    // The popup's page-link send binds the page again while the verify runs.
    startPageLink(chromeState);
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "show-toast").at(-1)).toMatchObject({
        tone: "error",
        actions: ["retry"],
      }),
    );
    const linkToken = boundToken(chromeState);
    expect(linkToken).not.toBe(verifyToken);

    messageListenerOf(chromeState)(
      { type: "cancel-active" },
      extensionPageSender("popup.html"),
    );
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "hide-toast")).toEqual([
        {
          type: "hide-toast",
          runtimeVersion: "0.9.0",
          sessionToken: verifyToken,
        },
      ]),
    );
    // The stop takes only its own binding; the send's Retry still works.
    expect(store.get(TOAST_BINDINGS_KEY)).toEqual([
      expect.objectContaining({ sessionToken: linkToken, actions: ["retry"] }),
    ]);
    sendLink.mockResolvedValue(undefined);
    messageListenerOf(chromeState)(
      { type: "toast-action", sessionToken: linkToken, action: "retry" },
      pickerSender(),
    );
    await waitForCall(sendLink, 2);
  });

  it("names the connected progress button Stop waiting, which ends only the wait", async () => {
    const chromeState = setupChrome();
    boundPage(chromeState);
    mocks.isIntegrationConnected.mockResolvedValue(true);
    // The client's own stop text; the worker shows it as given.
    const stopText = "Stopped waiting for DigiBot.";
    const { IntegrationClientError } =
      await import("../../src/integration-client.js");
    mocks.runIntegratedImageAction.mockImplementation(
      (
        _action: string,
        _selection: unknown,
        { signal }: { signal: AbortSignal },
      ) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () =>
            reject(
              new IntegrationClientError(stopText, "user_cancelled", false),
            ),
          );
        }),
    );
    await loadBackground();

    contextMenuVerify(chromeState);
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "show-toast")).toHaveLength(1),
    );
    const sessionToken = boundToken(chromeState);
    expect(tabMessages(chromeState, "show-toast")[0]).toMatchObject({
      tone: "progress",
      message: "page.example · DigiBot check",
      actions: ["stop-waiting"],
    });

    messageListenerOf(chromeState)(
      { type: "toast-action", sessionToken, action: "stop-waiting" },
      pickerSender(),
    );
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "hide-toast")).toEqual([
        { type: "hide-toast", runtimeVersion: "0.9.0", sessionToken },
      ]),
    );
    expect(mocks.setWorkflowState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "idle",
        message: stopText,
      }),
    );
    expect(tabMessages(chromeState, "show-toast")).toHaveLength(1);
    expect(mocks.appendHistory).not.toHaveBeenCalled();
  });

  it("adds Details and the SynthID check to an image result, and the check saves the file without a record", async () => {
    const chromeState = setupChrome();
    boundPage(chromeState);
    mocks.getSynthIdDisclosureVersion.mockResolvedValue(1);
    mocks.actionHandler
      .mockResolvedValueOnce({
        kind: "api",
        outcome: { ...detectedOutcome(), imageSha256: "a".repeat(64) },
      })
      .mockResolvedValueOnce(websiteHandoff());
    await loadBackground();

    contextMenuVerify(chromeState);
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "show-toast")).toHaveLength(2),
    );
    const resultToken = boundToken(chromeState);
    expect(tabMessages(chromeState, "show-toast")[1]).toMatchObject({
      sessionToken: resultToken,
      tone: "detected",
      resultId: FIRST_RESULT_ID,
      actions: ["details", "check-synthid"],
    });

    messageListenerOf(chromeState)(
      {
        type: "toast-action",
        sessionToken: resultToken,
        action: "check-synthid",
      },
      pickerSender(),
    );
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "picker-start")).toHaveLength(1),
    );
    const start = tabMessages(chromeState, "picker-start")[0];
    expect(start).toMatchObject({ label: "synthid" });
    expect(start).not.toHaveProperty("mode");
    expect(chromeState.api.permissions.contains).toHaveBeenCalledWith({
      permissions: ["downloads"],
    });

    messageListenerOf(chromeState)(
      {
        type: "picker-selected",
        sessionToken: start?.["sessionToken"],
        selection: selection(),
      },
      pickerSender(),
    );
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "show-toast")).toHaveLength(3),
    );
    expect(tabMessages(chromeState, "show-toast")[2]).toEqual({
      type: "show-toast",
      runtimeVersion: "0.9.0",
      sessionToken: start?.["sessionToken"],
      tone: "success",
      title: "Exact image saved",
      message: "Upload it on Google's SynthID Detector in the new tab.",
      resultId: null,
    });
    expect(mocks.actionHandler).toHaveBeenCalledTimes(2);
    // Only the verify result has a record; the handoff keeps none.
    expect(mocks.appendHistory).toHaveBeenCalledTimes(1);
    expect(mocks.createHistoryRecord).toHaveBeenCalledTimes(1);
  });

  it("asks for the SynthID acknowledgement once, then arms the SynthID picker", async () => {
    const chromeState = setupChrome();
    boundPage(chromeState);
    mocks.setSynthIdDisclosureVersion.mockImplementation((version: number) => {
      mocks.getSynthIdDisclosureVersion.mockResolvedValue(version);
      return Promise.resolve();
    });
    await loadBackground();

    messageListenerOf(chromeState)(
      { type: "start-action", actionId: SYNTHID_ACTION_ID, trigger: "popup" },
      extensionPageSender("palette.html"),
    );
    await waitForCall(
      chromeState.api.tabs.create as ReturnType<typeof vi.fn>,
      1,
    );
    const [created] =
      (
        chromeState.api.tabs.create as ReturnType<
          typeof vi.fn<(options: chrome.tabs.CreateProperties) => unknown>
        >
      ).mock.calls[0] ?? [];
    const url = new URL(created?.url ?? "");
    expect(url.pathname).toBe("/disclosure.html");
    expect(url.searchParams.get("kind")).toBe("synthid");
    expect(chromeState.executeScript).not.toHaveBeenCalled();

    messageListenerOf(chromeState)(
      {
        type: "resume-permission",
        pendingId: url.searchParams.get("pending"),
        verificationMode: "synthid",
      },
      extensionPageSender("disclosure.html"),
    );
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "picker-start")).toHaveLength(1),
    );
    expect(mocks.setSynthIdDisclosureVersion).toHaveBeenCalledWith(1);
    expect(tabMessages(chromeState, "picker-start")[0]).toMatchObject({
      label: "synthid",
    });
    expect(mocks.updateSettings).not.toHaveBeenCalled();

    // Acknowledged once: the next handoff arms the picker at once.
    messageListenerOf(chromeState)(
      { type: "start-action", actionId: SYNTHID_ACTION_ID, trigger: "popup" },
      extensionPageSender("palette.html"),
    );
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "picker-start")).toHaveLength(2),
    );
    expect(chromeState.api.tabs.create).toHaveBeenCalledTimes(1);
  });

  it("shows a picked handoff's failure with its button and opens Extension access from it", async () => {
    const chromeState = setupChrome();
    boundPage(chromeState);
    mocks.getSynthIdDisclosureVersion.mockResolvedValue(1);
    mocks.actionHandler.mockResolvedValueOnce({
      kind: "website",
      status: "error",
      errorCode: "permission_denied",
      message:
        "Grant optional download access in Settings before checking with Google SynthID.",
    });
    await loadBackground();

    messageListenerOf(chromeState)(
      { type: "start-action", actionId: SYNTHID_ACTION_ID, trigger: "popup" },
      extensionPageSender("palette.html"),
    );
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "picker-start")).toHaveLength(1),
    );
    const sessionToken = tabMessages(chromeState, "picker-start")[0]?.[
      "sessionToken"
    ];
    messageListenerOf(chromeState)(
      { type: "picker-selected", sessionToken, selection: selection() },
      pickerSender(),
    );
    // The binding keeps only the page fields of the picker session.
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "show-toast")).toEqual([
        {
          type: "show-toast",
          runtimeVersion: "0.9.0",
          sessionToken,
          tone: "error",
          title: "Google SynthID handoff failed",
          message:
            "Grant optional download access in Settings before checking with Google SynthID.",
          resultId: null,
          actions: ["grant-access"],
        },
      ]),
    );

    messageListenerOf(chromeState)(
      { type: "toast-action", sessionToken, action: "grant-access" },
      pickerSender(),
    );
    await vi.waitFor(() =>
      expect(chromeState.api.tabs.create).toHaveBeenCalledWith({
        url: "chrome-extension://test/settings.html#permissions-heading",
      }),
    );
  });

  it("opens Extension access instead of the SynthID picker without download access", async () => {
    const chromeState = setupChrome();
    boundPage(chromeState);
    (
      chromeState.api.permissions.contains as ReturnType<typeof vi.fn>
    ).mockResolvedValue(false);
    mocks.getSynthIdDisclosureVersion.mockResolvedValue(1);
    await loadBackground();

    messageListenerOf(chromeState)(
      { type: "start-action", actionId: SYNTHID_ACTION_ID, trigger: "popup" },
      extensionPageSender("palette.html"),
    );
    await vi.waitFor(() =>
      expect(chromeState.api.tabs.create).toHaveBeenCalledWith({
        url: "chrome-extension://test/settings.html#permissions-heading",
      }),
    );
    expect(chromeState.executeScript).not.toHaveBeenCalled();
    expect(mocks.actionHandler).not.toHaveBeenCalled();
  });
});

type ActionStub = {
  setPopup: ReturnType<typeof vi.fn>;
  openPopup: ReturnType<typeof vi.fn>;
};

describe("the Lens palette in the worker", () => {
  const OPEN_KEY = "provenanceLens.paletteOpen";
  const MOUNTS_KEY = "provenanceLens.paletteMounts";
  const UUID = /^[0-9a-f-]{36}$/u;

  beforeEach(() => {
    vi.resetModules();
    setupMocks();
  });

  function storeOf(chromeState: ReturnType<typeof setupChrome>) {
    const store = new Map<string, unknown>();
    chromeState.sessionGet.mockImplementation((key: string) =>
      Promise.resolve(store.has(key) ? { [key]: store.get(key) } : {}),
    );
    chromeState.sessionSet.mockImplementation(
      (values: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(values))
          store.set(key, value);
        return Promise.resolve();
      },
    );
    chromeState.sessionRemove.mockImplementation((key: string) => {
      store.delete(key);
      return Promise.resolve();
    });
    return store;
  }

  function messageListenerOf(chromeState: ReturnType<typeof setupChrome>) {
    return chromeState.onMessage.addListener.mock.calls[0]?.[0] as (
      message: unknown,
      sender: chrome.runtime.MessageSender,
      sendResponse?: (response: unknown) => void,
    ) => unknown;
  }

  function listenerOf<T extends (...args: never[]) => unknown>(target: {
    addListener: ReturnType<typeof vi.fn>;
  }): T {
    return target.addListener.mock.calls[0]?.[0] as T;
  }

  function clickToolbar(
    chromeState: ReturnType<typeof setupChrome>,
    tab: Partial<chrome.tabs.Tab> = {},
  ): void {
    listenerOf<(tab: chrome.tabs.Tab) => void>(chromeState.onActionClicked)({
      id: TAB_ID,
      url: PAGE_URL,
      windowId: WINDOW_ID,
      ...tab,
    } as chrome.tabs.Tab);
  }

  function hostReady(chromeState: ReturnType<typeof setupChrome>): void {
    chromeState.executeScript.mockResolvedValue([
      { frameId: 0, documentId: DOCUMENT_ID, result: { status: "ready" } },
    ]);
  }

  function paletteFrame({
    tabId = TAB_ID,
    token = "frame",
    active = true,
  }: {
    tabId?: number;
    token?: string | undefined;
    active?: boolean;
  } = {}): chrome.runtime.MessageSender {
    return {
      tab: { id: tabId, active } as chrome.tabs.Tab,
      frameId: 4,
      url: `chrome-extension://test/palette.html#t=${token}`,
    };
  }

  function lastPopupToken(chromeState: ReturnType<typeof setupChrome>) {
    const setPopup = chromeState.api.action.setPopup as ReturnType<
      typeof vi.fn
    >;
    const popup = setPopup.mock.calls
      .map(([details]) => (details as { popup: string }).popup)
      .find((value) => value !== "");
    return popup?.split("#t=")[1];
  }

  it("builds every right-click item after one removeAll, shared by install and load", async () => {
    const chromeState = setupChrome();
    await loadBackground();
    listenerOf<() => void>(chromeState.api.runtime.onInstalled as never)();
    const menus = chromeState.api.contextMenus as unknown as {
      removeAll: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
    };
    await vi.waitFor(() => expect(menus.create).toHaveBeenCalledTimes(11));
    expect(menus.removeAll).toHaveBeenCalledTimes(1);
    const items = menus.create.mock.calls.map(
      ([item]) => item as chrome.contextMenus.CreateProperties,
    );
    expect(items.map(({ id, title }) => [id, title])).toEqual([
      [ACTION_ID, "Verify this image"],
      ["lens-send-image", "Send this image to Telegram"],
      ["lens-link-video", "Send link to Telegram as video"],
      ["lens-link-audio", "Send link to Telegram as voice note"],
      ["lens-link-audio-file", "Send link to Telegram as audio file"],
      ["lens-media-video", "Send this video to Telegram"],
      ["lens-media-open", "Lens palette for this video…"],
      ["lens-open", "Open Lens palette"],
      ["lens-act-settings", "Settings…"],
      ["lens-act-recent", "Recent actions…"],
      ["lens-act-history", "Result history"],
    ]);
    // An image shows three items under one parent.
    expect(
      items.filter((item) => item.contexts?.includes("image")),
    ).toHaveLength(3);
    for (const item of items.slice(0, 8))
      expect(item.documentUrlPatterns).toEqual(["http://*/*", "https://*/*"]);
    for (const item of items.slice(8))
      expect(item.contexts).toEqual(["action"]);
  });

  it("mounts the palette through the host with a single-use record", async () => {
    const chromeState = setupChrome();
    const store = storeOf(chromeState);
    hostReady(chromeState);
    await loadBackground();

    clickToolbar(chromeState);

    await waitForCall(chromeState.executeScript, 1);
    const injection = chromeState.executeScript.mock.calls[0]?.[0] as {
      target: unknown;
      func: unknown;
      args: [string, string, number];
    };
    expect(injection.target).toEqual({ tabId: TAB_ID, frameIds: [0] });
    // vi.resetModules() gives each test its own module copy, so the name is
    // the stable check.
    expect((injection.func as () => unknown).name).toBe("mountPaletteHost");
    const [frameUrl, token, timeout] = injection.args;
    expect(token).toMatch(UUID);
    expect(frameUrl).toBe(`chrome-extension://test/palette.html#t=${token}`);
    expect(timeout).toBe(1_500);
    expect(store.get(OPEN_KEY)).toEqual({
      token,
      tabId: TAB_ID,
      view: "root",
      host: "page",
      page: "web",
      hostname: "page.example",
      scope: "page",
      needsPick: false,
    });
    await vi.waitFor(() =>
      expect(store.get(MOUNTS_KEY)).toEqual([{ tabId: TAB_ID, token }]),
    );
    expect(chromeState.api.action.setPopup).not.toHaveBeenCalled();
  });

  it("accepts start-action only from the palette frame it mounted, in the active tab", async () => {
    const chromeState = setupChrome();
    storeOf(chromeState);
    hostReady(chromeState);
    mocks.getActionDefinition.mockReturnValue({
      inputType: "page-link",
      handler: mocks.actionHandler,
    });
    mocks.actionHandler.mockResolvedValue(undefined);
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    await loadBackground();
    const send = messageListenerOf(chromeState);
    const start = {
      type: "start-action",
      actionId: LINK_ACTION_ID,
      trigger: "popup",
    };

    send(start, paletteFrame());
    await flush();
    expect(mocks.actionHandler).not.toHaveBeenCalled();

    clickToolbar(chromeState);
    await waitForCall(chromeState.executeScript, 1);
    const token = (
      chromeState.executeScript.mock.calls[0]?.[0] as { args: string[] }
    ).args[1];
    await flush();

    // Another tab, another palette frame in the same tab, an inactive tab.
    send(start, paletteFrame({ tabId: 8, token }));
    send(
      start,
      paletteFrame({ token: "00000000-0000-4000-8000-000000000000" }),
    );
    send(start, paletteFrame({ token, active: false }));
    send(
      {
        type: "resume-permission",
        pendingId: FIRST_RESULT_ID,
        verificationMode: "api",
      },
      paletteFrame({ token }),
    );
    await flush();
    await flush();
    expect(mocks.actionHandler).not.toHaveBeenCalled();

    send(start, paletteFrame({ token }));
    await waitForCall(mocks.actionHandler, 1);
    expect(mocks.actionHandler).toHaveBeenCalledWith({ url: PAGE_URL }, {});

    // The host's port closes with the palette; the tab is forgotten.
    let disconnect: () => void = () => undefined;
    listenerOf<(port: chrome.runtime.Port) => void>(chromeState.onConnect)({
      name: `lens-palette:${token}`,
      onDisconnect: {
        addListener: (listener: () => void) => {
          disconnect = listener;
        },
      },
      disconnect: vi.fn(),
    } as unknown as chrome.runtime.Port);
    disconnect();
    await flush();
    await flush();
    send(start, paletteFrame({ token }));
    await flush();
    await flush();
    expect(mocks.actionHandler).toHaveBeenCalledTimes(1);
  });

  it("opens the fallback popup when the host fails: focus, set, open, then reset", async () => {
    const chromeState = setupChrome();
    const store = storeOf(chromeState);
    chromeState.executeScript.mockRejectedValue(new Error("Cannot access"));
    await loadBackground();

    clickToolbar(chromeState);

    const { action, windows } = chromeState.api as unknown as {
      action: ActionStub;
      windows: { update: ReturnType<typeof vi.fn> };
    };
    await vi.waitFor(() => expect(action.setPopup).toHaveBeenCalledTimes(2));
    const token = lastPopupToken(chromeState);
    expect(token).toMatch(UUID);
    expect(windows.update).toHaveBeenCalledWith(WINDOW_ID, { focused: true });
    expect(action.setPopup).toHaveBeenNthCalledWith(1, {
      tabId: TAB_ID,
      popup: `palette.html?host=popup#t=${token}`,
    });
    expect(action.openPopup).toHaveBeenCalledWith({ windowId: WINDOW_ID });
    expect(action.setPopup).toHaveBeenNthCalledWith(2, {
      tabId: TAB_ID,
      popup: "",
    });
    const order = [
      windows.update.mock.invocationCallOrder[0],
      action.setPopup.mock.invocationCallOrder[0],
      action.openPopup.mock.invocationCallOrder[0],
      action.setPopup.mock.invocationCallOrder[1],
    ];
    expect(order).toEqual(
      [...order].sort((left = 0, right = 0) => left - right),
    );
    expect(store.get(OPEN_KEY)).toMatchObject({ token, host: "popup" });
    expect(store.get(MOUNTS_KEY)).toEqual([]);
  });

  it("opens the palette in a tab when the popup is refused for an inactive window", async () => {
    const chromeState = setupChrome();
    const store = storeOf(chromeState);
    const action = chromeState.api.action as unknown as ActionStub;
    action.openPopup.mockRejectedValue(
      new Error("Cannot show popup for an inactive window"),
    );
    await loadBackground();

    clickToolbar(chromeState, { url: "chrome://newtab/" });

    await waitForCall(
      chromeState.api.tabs.create as ReturnType<typeof vi.fn>,
      1,
    );
    await vi.waitFor(() =>
      expect(action.setPopup).toHaveBeenLastCalledWith({
        tabId: TAB_ID,
        popup: "",
      }),
    );
    // The tab gets its own single-use record, not the refused popup's.
    const popupToken = lastPopupToken(chromeState);
    const tabRecord = store.get(OPEN_KEY) as { token: string };
    expect(tabRecord.token).toMatch(UUID);
    expect(tabRecord).toEqual({
      token: tabRecord.token,
      tabId: TAB_ID,
      view: "root",
      host: "tab",
      page: "none",
      hostname: "",
      scope: "page",
      needsPick: false,
    });
    expect(tabRecord.token).not.toBe(popupToken);
    expect(chromeState.api.tabs.create).toHaveBeenCalledWith({
      url: `chrome-extension://test/palette.html#t=${tabRecord.token}`,
    });
    // A browser page gets no injection.
    expect(chromeState.executeScript).not.toHaveBeenCalled();
  });

  it("closes an open palette on the second press and opens nothing else", async () => {
    const chromeState = setupChrome();
    const store = storeOf(chromeState);
    chromeState.executeScript.mockResolvedValue([
      { frameId: 0, result: { status: "closed" } },
    ]);
    await loadBackground();

    listenerOf<(command: string, tab: chrome.tabs.Tab) => void>(
      chromeState.onCommand,
    )("open-palette", {
      id: TAB_ID,
      url: PAGE_URL,
      windowId: WINDOW_ID,
    } as chrome.tabs.Tab);

    await waitForCall(chromeState.executeScript, 1);
    await vi.waitFor(() => expect(store.has(OPEN_KEY)).toBe(false));
    expect(store.get(MOUNTS_KEY)).toEqual([]);
    expect(chromeState.api.action.setPopup).not.toHaveBeenCalled();
  });

  it("runs the declared commands with no palette, and open-clip opens it at Clip", async () => {
    const chromeState = setupChrome();
    const store = storeOf(chromeState);
    chromeState.setBadgeText.mockResolvedValue(undefined);
    mocks.getActionDefinition.mockReturnValue({
      inputType: "page-link",
      handler: mocks.actionHandler,
    });
    mocks.actionHandler.mockResolvedValue(undefined);
    await loadBackground();
    const command = listenerOf<
      (command: string, tab?: chrome.tabs.Tab) => void
    >(chromeState.onCommand);

    command("send-page-audio");
    await waitForCall(mocks.actionHandler, 1);
    expect(mocks.actionHandler).toHaveBeenCalledWith(
      { url: PAGE_URL },
      { output: "voice" },
    );
    await vi.waitFor(() =>
      expect(chromeState.setBadgeText).toHaveBeenCalledWith({
        tabId: TAB_ID,
        text: "",
      }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    command("send-page-audio-file");
    await waitForCall(mocks.actionHandler, 2);
    expect(mocks.actionHandler).toHaveBeenLastCalledWith(
      { url: PAGE_URL },
      { output: "m4a" },
    );

    chromeState.executeScript.mockResolvedValue([
      { frameId: 0, result: { status: "ready" } },
    ]);
    command("open-clip");
    await vi.waitFor(() =>
      expect(store.get(OPEN_KEY)).toMatchObject({ view: "clip" }),
    );
    command("not-a-command");
  });

  it("starts the post picker for a page link on an X timeline", async () => {
    const chromeState = setupChrome();
    chromeState.setBadgeText.mockResolvedValue(undefined);
    chromeState.executeScript.mockResolvedValue([
      { frameId: 0, documentId: DOCUMENT_ID },
    ]);
    chromeState.tabsQuery.mockResolvedValue([
      { id: TAB_ID, url: "https://x.com/home", windowId: WINDOW_ID },
    ]);
    mocks.isIntegrationConnected.mockResolvedValue(true);
    mocks.getActionDefinition.mockReturnValue({
      inputType: "page-link",
      handler: mocks.actionHandler,
    });
    await loadBackground();

    messageListenerOf(chromeState)(
      {
        type: "start-action",
        actionId: LINK_ACTION_ID,
        trigger: "popup",
        options: { output: "mp3" },
      },
      extensionPageSender("palette.html"),
    );

    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "picker-start")).toHaveLength(1),
    );
    expect(tabMessages(chromeState, "picker-start")[0]).toMatchObject({
      mode: "link",
      label: "send-video",
    });
    expect(mocks.actionHandler).not.toHaveBeenCalled();
  });

  it("sends a right-clicked link and refuses an X link that is not a post", async () => {
    const chromeState = setupChrome();
    chromeState.setBadgeText.mockResolvedValue(undefined);
    chromeState.executeScript.mockResolvedValue([
      { frameId: 0, documentId: DOCUMENT_ID },
    ]);
    mocks.getActionDefinition.mockReturnValue({
      inputType: "page-link",
      handler: mocks.actionHandler,
    });
    mocks.actionHandler.mockResolvedValue(undefined);
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    await loadBackground();
    const click = listenerOf<
      (info: chrome.contextMenus.OnClickData, tab: chrome.tabs.Tab) => void
    >(chromeState.onContextMenuClicked);
    const tab = {
      id: TAB_ID,
      url: PAGE_URL,
      windowId: WINDOW_ID,
    } as chrome.tabs.Tab;

    for (const [menuItemId, output, label] of [
      ["lens-link-audio", "voice", "Voice note"],
      ["lens-link-audio-file", "m4a", "Audio file"],
    ] as const) {
      const sent = mocks.actionHandler.mock.calls.length;
      click(
        {
          menuItemId,
          linkUrl: "https://youtu.be/dQw4w9WgXcQ",
        } as chrome.contextMenus.OnClickData,
        tab,
      );
      await waitForCall(mocks.actionHandler, sent + 1);
      expect(mocks.actionHandler).toHaveBeenLastCalledWith(
        { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
        { output },
      );
      await vi.waitFor(() =>
        expect(tabMessages(chromeState, "show-toast").slice(-2)).toEqual([
          expect.objectContaining({
            tone: "progress",
            message: `www.youtube.com · ${label}`,
          }),
          expect.objectContaining({ tone: "success" }),
        ]),
      );
      await flush();
    }

    click(
      {
        menuItemId: "lens-link-video",
        linkUrl: "https://x.com/home",
      } as chrome.contextMenus.OnClickData,
      tab,
    );
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "show-toast").at(-1)).toMatchObject({
        tone: "error",
        message:
          "That link cannot be sent to Telegram. On X, right-click the post's timestamp.",
      }),
    );
    await flush();
    expect(mocks.actionHandler).toHaveBeenCalledTimes(2);
  });

  it("checks the palette's audio range in the worker and reports on the page", async () => {
    const chromeState = setupChrome();
    chromeState.setBadgeText.mockResolvedValue(undefined);
    chromeState.executeScript.mockResolvedValue([
      { frameId: 0, documentId: DOCUMENT_ID },
    ]);
    mocks.isIntegrationConnected.mockResolvedValue(true);
    mocks.getActionDefinition.mockReturnValue({
      inputType: "audio-file",
      handler: mocks.actionHandler,
    });
    mocks.runIntegratedAudioSegmentAction.mockResolvedValue({
      mediaSha256: null,
      status: {
        state: "succeeded",
        envelope: {
          result: {
            evidence: {
              verdict: "no_supported_openai_signal",
              summary: "No supported signal.",
            },
          },
        },
      },
    });
    await loadBackground();

    messageListenerOf(chromeState)(
      {
        type: "start-action",
        actionId: AUDIO_ACTION_ID,
        trigger: "popup",
        options: { startSeconds: 30, endSeconds: 60 },
      },
      extensionPageSender("palette.html"),
    );

    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "show-toast")).toHaveLength(2),
    );
    // The pending operation keeps Recent's entry, so a resume can end it.
    expect(mocks.runIntegratedAudioSegmentAction).toHaveBeenCalledWith(
      PAGE_URL,
      30,
      60,
      recent.entries[0]?.id,
    );
    // Without a range the action opens audio.html; with one it never does.
    expect(mocks.actionHandler).not.toHaveBeenCalled();
    const [progress, result] = tabMessages(chromeState, "show-toast");
    expect(progress).toMatchObject({
      tone: "progress",
      title: "Verifying audio…",
      message: "page.example · DigiBot check",
    });
    expect(result).toMatchObject({
      tone: "no-signal",
      title: "No supported OpenAI audio signal detected",
      message:
        "This does not prove that the audio is human-recorded or that it was not generated by another AI system.",
      actions: ["history"],
    });
  });
});

describe("Recent's activity list", () => {
  const OPERATION_ID = "323e4567-e89b-42d3-a456-426614174000";
  const VIDEO_URL = "https://www.youtube.com/watch?v=abcdefghijk";

  beforeEach(() => {
    vi.resetModules();
    setupMocks();
  });

  function listenerOf(chromeState: ReturnType<typeof setupChrome>) {
    return chromeState.onMessage.addListener.mock.calls[0]?.[0] as (
      message: unknown,
      sender: chrome.runtime.MessageSender,
    ) => void;
  }

  function menuClick(
    chromeState: ReturnType<typeof setupChrome>,
    info: Partial<chrome.contextMenus.OnClickData>,
  ): void {
    const listener = chromeState.onContextMenuClicked.addListener.mock
      .calls[0]?.[0] as (
      info: chrome.contextMenus.OnClickData,
      tab: chrome.tabs.Tab,
    ) => void;
    listener(
      { frameId: 0, ...info } as chrome.contextMenus.OnClickData,
      {
        id: TAB_ID,
        url: PAGE_URL,
        title: "A page",
        windowId: WINDOW_ID,
      } as chrome.tabs.Tab,
    );
  }

  function start(
    chromeState: ReturnType<typeof setupChrome>,
    actionId: string,
    options?: Record<string, unknown>,
  ): void {
    listenerOf(chromeState)(
      {
        type: "start-action",
        actionId,
        trigger: "popup",
        ...(options ? { options } : {}),
      },
      extensionPageSender("palette.html"),
    );
  }

  const pickerSender = (): chrome.runtime.MessageSender => ({
    tab: { id: TAB_ID } as chrome.tabs.Tab,
    frameId: 0,
    documentId: DOCUMENT_ID,
    url: PAGE_URL,
  });

  /** A browser whose page accepts the picker, with every action routed. */
  function connected(chromeState: ReturnType<typeof setupChrome>) {
    chromeState.setBadgeText.mockResolvedValue(undefined);
    chromeState.executeScript.mockResolvedValue([
      { frameId: 0, documentId: DOCUMENT_ID },
    ]);
    mocks.isIntegrationConnected.mockResolvedValue(true);
    const sent = {
      page: vi.fn().mockResolvedValue(OPERATION_ID),
      video: vi.fn().mockResolvedValue(OPERATION_ID),
    };
    mocks.getActionDefinition.mockImplementation((actionId: string) =>
      actionId === LINK_ACTION_ID
        ? { inputType: "page-link", handler: sent.page }
        : actionId === PICK_VIDEO_ACTION_ID
          ? { inputType: "video-pick", handler: sent.video }
          : { inputType: "image-file", handler: mocks.actionHandler },
    );
    return sent;
  }

  async function armedPick(
    chromeState: ReturnType<typeof setupChrome>,
  ): Promise<string> {
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "picker-start")).toHaveLength(1),
    );
    return tabMessages(chromeState, "picker-start")[0]?.[
      "sessionToken"
    ] as string;
  }

  async function onlyEntry(match: Partial<ActivityEntry>): Promise<void> {
    await vi.waitFor(() =>
      expect(recent.entries).toEqual([expect.objectContaining(match)]),
    );
  }

  it.each([
    { options: undefined, title: "Send video", kind: "video" },
    { options: { output: "voice" }, title: "Send voice note", kind: "voice" },
    {
      options: { output: "m4a" },
      title: "Send audio file",
      kind: "audio-file",
    },
    {
      options: { startSeconds: 5, endSeconds: 9 },
      title: "Send clip of this page",
      kind: "clip",
    },
  ])(
    "writes one $kind entry for $title and ends it as sent",
    async ({ options, title, kind }) => {
      const chromeState = setupChrome();
      const sent = connected(chromeState);
      await loadBackground();

      start(chromeState, LINK_ACTION_ID, options);

      await waitForCall(sent.page, 1);
      await onlyEntry({ state: "sent" });
      const { id, startedAt, ...entry } = recent.entries[0] ?? {};
      expect(id).toMatch(/^[0-9a-f-]{36}$/u);
      expect(Date.parse(startedAt ?? "")).not.toBeNaN();
      expect(entry).toEqual({
        title,
        kind,
        tabId: TAB_ID,
        pageTitle: null,
        pageUrl: PAGE_URL,
        linkUrl: PAGE_URL,
        state: "sent",
        message: "Queued in DigiBot. The result arrives in your Telegram chat.",
        operationId: OPERATION_ID,
        recordId: null,
      });
      expect(mocks.startActivity).toHaveBeenCalledTimes(1);
      expect(mocks.startActivity).toHaveBeenCalledWith(
        expect.objectContaining({ state: "running", kind }),
        20,
      );
    },
  );

  it("names a key's start after its palette row", async () => {
    const chromeState = setupChrome();
    connected(chromeState);
    await loadBackground();

    const onCommand = chromeState.onCommand.addListener.mock.calls[0]?.[0] as (
      command: string,
      tab?: chrome.tabs.Tab,
    ) => void;
    onCommand("send-page-audio");

    await onlyEntry({ title: "Send voice note", kind: "voice", state: "sent" });
  });

  it("turns a download pick into a Sent video or Sent image entry at the click", async () => {
    for (const [picked, title, kind, linkUrl] of [
      [
        { type: "picker-link-selected", url: VIDEO_URL },
        "Sent video",
        "video",
        VIDEO_URL,
      ],
      [{ type: "picker-page-selected" }, "Sent video", "video", PAGE_URL],
      [
        { type: "picker-selected", selection: selection() },
        "Sent image",
        "image",
        null,
      ],
    ] as const) {
      vi.resetModules();
      setupMocks();
      const chromeState = setupChrome();
      connected(chromeState);
      mocks.runIntegratedImageAction.mockResolvedValue({
        status: {
          operationId: OPERATION_ID,
          state: "succeeded",
          error: null,
          envelope: null,
          archive: { deliveryState: "confirmed", integrityState: "verified" },
        },
      });
      await loadBackground();

      start(chromeState, DOWNLOAD_ACTION_ID);
      const sessionToken = await armedPick(chromeState);
      // Its output is not known before the click.
      await onlyEntry({
        title: "Pick to download",
        kind: "page-link",
        state: "running",
      });
      listenerOf(chromeState)({ ...picked, sessionToken }, pickerSender());

      await onlyEntry({
        title,
        kind,
        linkUrl,
        state: "sent",
        operationId: OPERATION_ID,
      });
    }
  });

  it("ends a failed or refused link send as failed or refused", async () => {
    for (const state of ["failed", "refused"] as const) {
      vi.resetModules();
      setupMocks();
      // The worker's own module instance, so its instanceof check holds.
      const { PageLinkError } =
        await import("../../src/actions/integration-link.js");
      const chromeState = setupChrome();
      const sent = connected(chromeState);
      sent.page.mockRejectedValue(
        state === "failed"
          ? new Error("DigiBot is down.")
          : new PageLinkError("That page cannot be sent."),
      );
      await loadBackground();

      start(chromeState, LINK_ACTION_ID);

      await waitForCall(sent.page, 1);
      await onlyEntry({ kind: "video", linkUrl: PAGE_URL, state });
    }
  });

  it("ends a failed DigiBot image send as failed, never sent", async () => {
    const chromeState = setupChrome();
    connected(chromeState);
    mocks.runIntegratedImageAction.mockResolvedValue({
      status: {
        operationId: OPERATION_ID,
        state: "failed",
        error: { code: "telegram_failed", message: "Telegram refused it." },
        envelope: null,
        archive: { deliveryState: "failed", integrityState: "not_checked" },
      },
    });
    await loadBackground();

    menuClick(chromeState, {
      menuItemId: "lens-send-image",
      srcUrl: IMAGE_URL,
    });

    await onlyEntry({
      kind: "image",
      state: "failed",
      message: "Telegram refused it.",
      operationId: OPERATION_ID,
    });
  });

  it("ends a right-clicked image send as an image entry with its operation id", async () => {
    const chromeState = setupChrome();
    connected(chromeState);
    mocks.runIntegratedImageAction.mockResolvedValue({
      status: {
        operationId: OPERATION_ID,
        state: "succeeded",
        error: null,
        envelope: null,
        archive: { deliveryState: "confirmed", integrityState: "verified" },
      },
    });
    await loadBackground();

    menuClick(chromeState, {
      menuItemId: "lens-send-image",
      srcUrl: IMAGE_URL,
    });

    await onlyEntry({
      title: "Send this image to Telegram",
      kind: "image",
      pageTitle: "A page",
      state: "sent",
      message: "The image was sent to your DigiBot chat.",
      operationId: OPERATION_ID,
    });
  });

  it("ends a picked verify as done with its saved record", async () => {
    const chromeState = setupChrome();
    chromeState.setBadgeText.mockResolvedValue(undefined);
    chromeState.executeScript.mockResolvedValue([
      { frameId: 0, documentId: DOCUMENT_ID },
    ]);
    mocks.actionHandler.mockResolvedValue({
      kind: "api",
      outcome: detectedOutcome(),
    });
    await loadBackground();

    start(chromeState, ACTION_ID);
    const sessionToken = await armedPick(chromeState);
    await onlyEntry({ title: "Pick an image to verify", kind: "verify" });
    listenerOf(chromeState)(
      { type: "picker-selected", sessionToken, selection: selection() },
      pickerSender(),
    );

    await onlyEntry({
      state: "done",
      message: "OpenAI provenance detected",
      recordId: FIRST_RESULT_ID,
    });
  });

  it("ends a refused start, a cancelled pick and a pick in a closed tab", async () => {
    const chromeState = setupChrome();
    connected(chromeState);
    mocks.isIntegrationConnected.mockResolvedValue(false);
    await loadBackground();

    // Not connected: the media pick is refused before it arms.
    start(chromeState, DOWNLOAD_ACTION_ID);
    await onlyEntry({
      state: "refused",
      message:
        "Connect Provenance Lens to DigiBot in Settings before picking an image or a video.",
    });

    mocks.isIntegrationConnected.mockResolvedValue(true);
    start(chromeState, DOWNLOAD_ACTION_ID);
    const sessionToken = await armedPick(chromeState);
    listenerOf(chromeState)(
      { type: "picker-cancelled", sessionToken },
      pickerSender(),
    );
    await vi.waitFor(() =>
      expect(recent.entries[0]).toMatchObject({
        state: "cancelled",
        message: "Pick cancelled.",
      }),
    );

    start(chromeState, ACTION_ID);
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "picker-start")).toHaveLength(2),
    );
    const onRemoved = (
      chrome.tabs.onRemoved.addListener as ReturnType<typeof vi.fn>
    ).mock.calls[0]?.[0] as (tabId: number) => void;
    onRemoved(TAB_ID);
    await vi.waitFor(() =>
      expect(recent.entries[0]).toMatchObject({
        title: "Pick an image to verify",
        state: "cancelled",
        message: "The tab was closed before a pick.",
      }),
    );
    expect(recent.entries).toHaveLength(3);
  });

  it("ends a pick that another action's page binding replaced", async () => {
    const chromeState = setupChrome();
    const sent = connected(chromeState);
    await loadBackground();

    start(chromeState, DOWNLOAD_ACTION_ID);
    await armedPick(chromeState);
    // Send video binds the page again, which drops its armed picker.
    start(chromeState, LINK_ACTION_ID);
    await waitForCall(sent.page, 1);

    await vi.waitFor(() =>
      expect(recent.entries).toEqual([
        expect.objectContaining({ title: "Send video", state: "sent" }),
        expect.objectContaining({
          title: "Pick to download",
          state: "cancelled",
          message: "The pick ended when another action used the page.",
        }),
      ]),
    );
  });

  it("ends a right-clicked link that cannot be sent as refused", async () => {
    const chromeState = setupChrome();
    const sent = connected(chromeState);
    await loadBackground();

    menuClick(chromeState, {
      menuItemId: "lens-link-audio",
      linkUrl: "https://x.com/alice",
    });

    await onlyEntry({
      title: "Send link to Telegram as voice note",
      kind: "voice",
      state: "refused",
      message:
        "That link cannot be sent to Telegram. On X, right-click the post's timestamp.",
    });
    expect(sent.page).not.toHaveBeenCalled();
  });

  it("writes nothing while history keeps nothing", async () => {
    const chromeState = setupChrome();
    const sent = connected(chromeState);
    mocks.getSettings.mockResolvedValue({
      ...apiSettings(),
      historyRetention: 0,
    });
    await loadBackground();

    start(chromeState, LINK_ACTION_ID);

    await waitForCall(sent.page, 1);
    await flushWorker();
    expect(mocks.startActivity).toHaveBeenCalledWith(expect.anything(), 0);
    expect(recent.entries).toEqual([]);
    expect(mocks.updateActivity).not.toHaveBeenCalled();
  });

  const STOPPED = "Lens stopped before this action ended.";
  const ENTRY_IDS = [
    "a23e4567-e89b-42d3-a456-426614174000",
    "b23e4567-e89b-42d3-a456-426614174000",
    "c23e4567-e89b-42d3-a456-426614174000",
    "d23e4567-e89b-42d3-a456-426614174000",
    "e23e4567-e89b-42d3-a456-426614174000",
    "f23e4567-e89b-42d3-a456-426614174000",
    "923e4567-e89b-42d3-a456-426614174000",
  ] as const;

  /** An entry a stopped worker left running a minute ago. */
  function leftRunning(id: string, title: string): ActivityEntry {
    return {
      id,
      title,
      kind: "verify",
      tabId: TAB_ID,
      pageTitle: null,
      pageUrl: PAGE_URL,
      linkUrl: null,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      state: "running",
      message: null,
      operationId: null,
      recordId: null,
    };
  }

  it("ends at start-up each running entry no pick, disclosure, operation or page still holds", async () => {
    const [stale, picked, disclosed, pending, ended, newer, held] = ENTRY_IDS;
    recent.entries = [
      leftRunning(stale, "Pick an image to verify"),
      leftRunning(picked, "Pick to download"),
      leftRunning(disclosed, "Check with Google SynthID"),
      leftRunning(pending, "Send this image to Telegram"),
      { ...leftRunning(ended, "Send video"), state: "sent" },
      // A start time after the worker's own does not keep an entry.
      {
        ...leftRunning(newer, "Send video"),
        startedAt: new Date(Date.now() + 60_000).toISOString(),
      },
      leftRunning(held, "Verify an audio file"),
    ];
    // The audio page holds its running check's entry with a Web Lock.
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        query: () =>
          Promise.resolve({
            held: [
              { name: "another-lock" },
              { name: `provenance-lens.activity:${held}` },
            ],
          }),
      },
    });
    onTestFinished(() => {
      Reflect.deleteProperty(navigator, "locks");
    });
    const chromeState = setupChrome();
    chromeState.sessionGet.mockImplementation((key: string) =>
      Promise.resolve(
        key === "provenanceLens.linkPickerSessions"
          ? { [key]: { token: { activityId: picked } } }
          : key === "provenanceLens.pendingDisclosures"
            ? { [key]: { pending: { activityId: disclosed } } }
            : {},
      ),
    );
    mocks.pendingIntegrationActivityIds.mockResolvedValue([pending]);
    await loadBackground();

    await vi.waitFor(() =>
      expect(recent.entries[5]).toMatchObject({
        state: "failed",
        message: STOPPED,
      }),
    );
    expect(recent.entries.map(({ state }) => state)).toEqual([
      "failed",
      "running",
      "running",
      "running",
      "sent",
      "failed",
      "running",
    ]);
    expect(recent.entries[0]).toMatchObject({ message: STOPPED });
  });

  it("keeps running an action this worker starts while its start-up sweep runs, whatever the clock says", async () => {
    let release: (ids: string[]) => void = () => undefined;
    mocks.pendingIntegrationActivityIds.mockReturnValue(
      new Promise<string[]>((resolve) => {
        release = resolve;
      }),
    );
    const chromeState = setupChrome();
    chromeState.setBadgeText.mockResolvedValue(undefined);
    chromeState.executeScript.mockResolvedValue([
      { frameId: 0, documentId: DOCUMENT_ID },
    ]);
    await loadBackground();
    // The system clock steps back a minute after the worker started.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() - 60_000 });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    start(chromeState, ACTION_ID);
    await armedPick(chromeState);
    await onlyEntry({ title: "Pick an image to verify", state: "running" });

    release([]);
    await flushWorker();
    await onlyEntry({ title: "Pick an image to verify", state: "running" });
  });

  it("ends an armed image pick's entry once a restarted worker no longer holds the pick", async () => {
    let chromeState = setupChrome();
    chromeState.setBadgeText.mockResolvedValue(undefined);
    chromeState.executeScript.mockResolvedValue([
      { frameId: 0, documentId: DOCUMENT_ID },
    ]);
    await loadBackground();
    start(chromeState, ACTION_ID);
    const sessionToken = await armedPick(chromeState);
    await onlyEntry({ title: "Pick an image to verify", state: "running" });

    // Chrome stops the idle worker; the pick's click starts a new one.
    await new Promise((resolve) => setTimeout(resolve, 5));
    vi.resetModules();
    chromeState = setupChrome();
    await loadBackground();

    await onlyEntry({ state: "failed", message: STOPPED });
    listenerOf(chromeState)(
      { type: "picker-selected", sessionToken, selection: selection() },
      pickerSender(),
    );
    await flushWorker();
    expect(mocks.actionHandler).not.toHaveBeenCalled();
  });

  it("ends a stored DigiBot operation's entry when the restarted worker resumes it", async () => {
    const [settled, discarded, audioFile, oldSegment, oldEnvelope] = ENTRY_IDS;
    recent.entries = [
      leftRunning(settled, "Send this image to Telegram"),
      leftRunning(discarded, "Verify an audio file"),
      leftRunning(audioFile, "Verify an audio file"),
      leftRunning(oldSegment, "Verify audio of this page"),
      leftRunning(oldEnvelope, "Verify an audio file"),
    ];
    mocks.pendingIntegrationActivityIds.mockResolvedValue([
      settled,
      discarded,
      audioFile,
      oldSegment,
      oldEnvelope,
    ]);
    let onEnded:
      ((operation: unknown, status: unknown) => Promise<void>) | undefined;
    mocks.resumePendingIntegrationOperations.mockImplementation(
      (callback: typeof onEnded) => {
        onEnded = callback;
        return Promise.resolve();
      },
    );
    setupChrome();
    await loadBackground();
    await flushWorker();
    // The sweep leaves them to the resume.
    expect(recent.entries.map(({ state }) => state)).toEqual([
      "running",
      "running",
      "running",
      "running",
      "running",
    ]);

    const operation = {
      accountId: "account-fixture-1",
      sessionId: "session-fixture-1",
      createdAt: "2026-10-14T20:00:00.000Z",
    };
    await onEnded?.(
      { ...operation, operationId: OPERATION_ID, activityId: settled },
      {
        operationId: OPERATION_ID,
        action: "download",
        state: "failed",
        segment: null,
        envelope: null,
        error: { code: "telegram_failed", message: "Telegram refused it." },
      },
    );
    await onEnded?.(
      { ...operation, operationId: OPERATION_ID, activityId: discarded },
      null,
    );
    // An audio file check that failed before DigiBot read the file has no
    // segment or envelope; its stored kind still gives the audio wording.
    await onEnded?.(
      {
        ...operation,
        operationId: OPERATION_ID,
        activityId: audioFile,
        mediaKind: "audio",
      },
      {
        operationId: OPERATION_ID,
        action: "check",
        state: "failed",
        segment: null,
        envelope: null,
        error: null,
      },
    );
    // An operation an earlier build stored has no kind; a segment or an audio
    // envelope still gives the audio wording.
    const failedCheck = {
      operationId: OPERATION_ID,
      action: "check",
      state: "failed",
      segment: null,
      envelope: null,
      error: null,
    };
    await onEnded?.(
      { ...operation, operationId: OPERATION_ID, activityId: oldSegment },
      { ...failedCheck, segment: { startSeconds: 0, endSeconds: 60 } },
    );
    await onEnded?.(
      { ...operation, operationId: OPERATION_ID, activityId: oldEnvelope },
      {
        ...failedCheck,
        envelope: { media: { mimeType: "audio/mpeg" }, result: null },
      },
    );
    expect(recent.entries).toEqual([
      expect.objectContaining({
        state: "failed",
        message: "Telegram refused it.",
        operationId: OPERATION_ID,
      }),
      expect.objectContaining({ state: "failed", message: STOPPED }),
      expect.objectContaining({
        state: "failed",
        message: "The audio could not be checked.",
      }),
      expect.objectContaining({
        state: "failed",
        message: "The audio could not be checked.",
      }),
      expect.objectContaining({
        state: "failed",
        message: "The audio could not be checked.",
      }),
    ]);
  });

  it("cancels a check whose disclosure tab closes unacknowledged, and not one acknowledged", async () => {
    const DISCLOSURE_TAB_ID = 99;
    const chromeState = setupChrome();
    chromeState.setBadgeText.mockResolvedValue(undefined);
    chromeState.executeScript.mockResolvedValue([
      { frameId: 0, documentId: DOCUMENT_ID },
    ]);
    const create = chromeState.api.tabs.create as ReturnType<typeof vi.fn>;
    create.mockResolvedValue({ id: DISCLOSURE_TAB_ID });
    mocks.setSynthIdDisclosureVersion.mockImplementation((version: number) => {
      mocks.getSynthIdDisclosureVersion.mockResolvedValue(version);
      return Promise.resolve();
    });
    await loadBackground();
    const onRemoved = (
      chrome.tabs.onRemoved.addListener as ReturnType<typeof vi.fn>
    ).mock.calls[0]?.[0] as (tabId: number) => void;

    // Acknowledged: the page closes its own tab, and the pick goes on.
    start(chromeState, SYNTHID_ACTION_ID);
    await waitForCall(create, 1);
    await flushWorker();
    const [created] =
      (create.mock.calls[0] as [chrome.tabs.CreateProperties] | undefined) ??
      [];
    listenerOf(chromeState)(
      {
        type: "resume-permission",
        pendingId: new URL(created?.url ?? "").searchParams.get("pending"),
        verificationMode: "synthid",
      },
      extensionPageSender("disclosure.html"),
    );
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "picker-start")).toHaveLength(1),
    );
    onRemoved(DISCLOSURE_TAB_ID);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await onlyEntry({ state: "running" });

    // Closed without the acknowledgement: cancelled.
    recent.entries = [];
    mocks.getSynthIdDisclosureVersion.mockResolvedValue(null);
    start(chromeState, SYNTHID_ACTION_ID);
    await waitForCall(create, 2);
    await flushWorker();
    onRemoved(DISCLOSURE_TAB_ID);
    await vi.waitFor(
      () =>
        expect(recent.entries).toEqual([
          expect.objectContaining({
            title: "Check with Google SynthID",
            state: "cancelled",
            message: "The disclosure was closed before it was acknowledged.",
          }),
        ]),
      { timeout: 3_000 },
    );
  });

  it("starts a check acknowledged as its disclosure tab closes after a restart", async () => {
    const [disclosed] = ENTRY_IDS;
    const pendingId = "623e4567-e89b-42d3-a456-426614174000";
    recent.entries = [leftRunning(disclosed, "Check with Google SynthID")];
    const chromeState = setupChrome();
    chromeState.setBadgeText.mockResolvedValue(undefined);
    chromeState.executeScript.mockResolvedValue([
      { frameId: 0, documentId: DOCUMENT_ID },
    ]);
    // The disclosure a stopped worker opened, as session storage keeps it.
    const stored: Record<string, unknown> = {
      "provenanceLens.pendingDisclosures": {
        [pendingId]: {
          id: pendingId,
          actionId: SYNTHID_ACTION_ID,
          tabId: TAB_ID,
          frameId: 0,
          trigger: "popup",
          verificationMode: "synthid",
          selection: null,
          pageTarget: null,
          activityId: disclosed,
          disclosureTabId: 99,
        },
      },
    };
    chromeState.sessionGet.mockImplementation((key: string) =>
      Promise.resolve(
        key in stored ? { [key]: structuredClone(stored[key]) } : {},
      ),
    );
    chromeState.sessionSet.mockImplementation(
      (values: Record<string, unknown>) => {
        Object.assign(stored, structuredClone(values));
        return Promise.resolve();
      },
    );
    mocks.setSynthIdDisclosureVersion.mockImplementation((version: number) => {
      mocks.getSynthIdDisclosureVersion.mockResolvedValue(version);
      return Promise.resolve();
    });
    await loadBackground();
    const onRemoved = (
      chrome.tabs.onRemoved.addListener as ReturnType<typeof vi.fn>
    ).mock.calls[0]?.[0] as (tabId: number) => void;

    // The page acknowledges and closes its tab; the worker hears both.
    onRemoved(99);
    listenerOf(chromeState)(
      { type: "resume-permission", pendingId, verificationMode: "synthid" },
      extensionPageSender("disclosure.html"),
    );
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "picker-start")).toHaveLength(1),
    );
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await onlyEntry({ id: disclosed, state: "running" });
  });

  it("ends the oldest pending disclosure's entry when a ninth drops it", async () => {
    const chromeState = setupChrome();
    const stored: Record<string, unknown> = {};
    chromeState.sessionGet.mockImplementation((key: string) =>
      Promise.resolve(key in stored ? { [key]: stored[key] } : {}),
    );
    chromeState.sessionSet.mockImplementation(
      (values: Record<string, unknown>) => {
        Object.assign(stored, structuredClone(values));
        return Promise.resolve();
      },
    );
    const create = chromeState.api.tabs.create as ReturnType<typeof vi.fn>;
    await loadBackground();

    for (let index = 1; index <= 9; index += 1) {
      start(chromeState, SYNTHID_ACTION_ID);
      await waitForCall(create, index);
      await flushWorker();
    }

    await vi.waitFor(() =>
      expect(recent.entries.at(-1)).toMatchObject({
        state: "failed",
        message: STOPPED,
      }),
    );
    expect(
      recent.entries.filter(({ state }) => state === "running"),
    ).toHaveLength(8);
  });

  function flushWorker(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
});
