import {
  ACTION_ID,
  DISCLOSURE_VERSION,
  LINK_ACTION_ID,
  PICK_VIDEO_ACTION_ID,
  makeIndeterminateResult,
} from "@provenance-lens/shared";
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VerificationOutcome } from "../../src/actions/verify-openai-provenance.js";
import type * as IntegrationClient from "../../src/integration-client.js";

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
  openActionPopup: vi.fn(),
  isIntegrationConnected: vi.fn(),
}));

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
    popupLatestByWindow: "provenanceLens.popupLatestByWindow",
  },
  appendHistory: mocks.appendHistory,
  getHistory: mocks.getHistory,
  getLatestRecord: mocks.getLatestRecord,
  getResult: mocks.getResult,
  getSettings: mocks.getSettings,
  setWorkflowState: mocks.setWorkflowState,
  updateSettings: mocks.updateSettings,
}));

vi.mock("../../src/action-popup.js", () => ({
  openActionPopup: mocks.openActionPopup,
}));

// The real client has no storage here, so only the connection check is faked.
vi.mock("../../src/integration-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof IntegrationClient>()),
  isIntegrationConnected: mocks.isIntegrationConnected,
}));

vi.mock("../../src/notifications.js", () => ({
  detectedToastCopy: vi.fn(() => ({
    title: "Detected",
    message: "A supported signal was detected.",
  })),
  errorToastCopy: vi.fn((reason: string) => ({
    title: "Verification failed",
    message: reason,
  })),
  matchesResultToastBinding: vi.fn(() => false),
  noSignalToastCopy: vi.fn(() => ({
    title: "No signal",
    message: "No supported signal was detected.",
  })),
  removePageResultToastBindings: vi.fn(),
  removeResultToastBinding: vi.fn(),
  resultDetailsUrl: vi.fn(),
  sameResultToastBinding: vi.fn(() => false),
  upsertResultToastBinding: vi.fn(),
}));

const TAB_ID = 7;
const WINDOW_ID = 11;
const PAGE_URL = "https://page.example/";
const IMAGE_URL = "https://page.example/image.png";
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
  const onCommand = event();
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
  const tab = { id: TAB_ID, url: PAGE_URL, windowId: WINDOW_ID };
  const tabsQuery = vi.fn().mockResolvedValue([tab]);
  const api = {
    runtime: {
      onInstalled,
      onStartup,
      onMessage,
      getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
    },
    commands: { onCommand },
    contextMenus: {
      onClicked: onContextMenuClicked,
      remove: vi.fn().mockResolvedValue(undefined),
      create: vi.fn(),
    },
    storage: {
      onChanged: onStorageChanged,
      local: {
        setAccessLevel: vi.fn().mockResolvedValue(undefined),
      },
      session: {
        get: sessionGet,
        set: sessionSet,
        remove: vi.fn().mockResolvedValue(undefined),
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
    },
    scripting: { executeScript },
    action: { setBadgeText },
    permissions: { contains: vi.fn().mockResolvedValue(true) },
    downloads: { download: vi.fn().mockResolvedValue(1) },
  } as unknown as typeof chrome;
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: api,
  });
  return {
    api,
    onContextMenuClicked,
    onMessage,
    sendMessage,
    sessionGet,
    sessionSet,
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
  mocks.openActionPopup.mockResolvedValue(undefined);
  mocks.isIntegrationConnected.mockResolvedValue(false);
  let recordIndex = 0;
  mocks.createHistoryRecord.mockImplementation(
    (_selection: unknown, outcome: VerificationOutcome) => ({
      id:
        [FIRST_RESULT_ID, SECOND_RESULT_ID][recordIndex++] ?? SECOND_RESULT_ID,
      actionId: ACTION_ID,
      createdAt: "2026-09-04T00:00:00.000Z",
      sourceHostname: "page.example",
      pageTitle: null,
      inputKind: "original_file",
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
      extensionPageSender("popup.html"),
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
      extensionPageSender("popup.html"),
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

  it("passes the popup's output or clip through to the page-link action", async () => {
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
      { output: "m4a" },
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

  function tabMessages(
    chromeState: ReturnType<typeof setupChrome>,
    type: string,
  ): Record<string, unknown>[] {
    return chromeState.sendMessage.mock.calls
      .map(([, message]) => message as Record<string, unknown>)
      .filter((message) => message["type"] === type);
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

  /** Starts the video picker from the popup and returns its session token. */
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
      extensionPageSender("popup.html"),
    );
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "picker-start")).toHaveLength(1),
    );
    const start = tabMessages(chromeState, "picker-start")[0];
    expect(start).toMatchObject({ mode: "link" });
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

  it("sends a picked link with the popup's output and reports on the page", async () => {
    const chromeState = setupChrome();
    connectedVideoPick(chromeState);
    mocks.actionHandler.mockResolvedValue(undefined);
    await loadBackground();

    const sessionToken = await startVideoPick(chromeState, { output: "mp3" });
    messageListenerOf(chromeState)(
      { type: "picker-link-selected", sessionToken, url: PICKED_URL },
      pickerSender(),
    );

    await waitForCall(mocks.actionHandler, 1);
    expect(mocks.actionHandler).toHaveBeenCalledWith(
      { url: PICKED_URL },
      { output: "mp3" },
    );
    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "show-toast")).toHaveLength(1),
    );
    expect(tabMessages(chromeState, "picker-stop")).toEqual([
      expect.objectContaining({ sessionToken }),
    ]);
    expect(tabMessages(chromeState, "show-toast")[0]).toMatchObject({
      sessionToken,
      tone: "detected",
      title: "Sent to DigiBot",
      message: "Queued in DigiBot; the result arrives in your Telegram chat.",
      resultId: null,
    });
    const toastCall = chromeState.sendMessage.mock.calls.find(
      ([, message]) => (message as { type?: string }).type === "show-toast",
    );
    expect(toastCall?.[0]).toBe(TAB_ID);
    expect(toastCall?.[2]).toEqual({ documentId: DOCUMENT_ID });
    expect(chromeState.setBadgeText).toHaveBeenCalledWith({
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
      extensionPageSender("popup.html"),
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
      extensionPageSender("popup.html"),
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

  /** chrome.storage.session backed by one map, shared across worker restarts. */
  function sessionStorageOf(
    chromeState: ReturnType<typeof setupChrome>,
    store = new Map<string, unknown>(),
  ): Map<string, unknown> {
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
    return store;
  }

  const LINK_PICKER_SESSIONS_KEY = "provenanceLens.linkPickerSessions";

  it("sends a persisted link pick once after the worker restarted", async () => {
    const firstWorker = setupChrome();
    const store = sessionStorageOf(firstWorker);
    connectedVideoPick(firstWorker);
    await loadBackground();
    const sessionToken = await startVideoPick(firstWorker, { output: "mp3" });
    expect(store.get(LINK_PICKER_SESSIONS_KEY)).toEqual({
      [sessionToken]: {
        sessionToken,
        tabId: TAB_ID,
        frameId: 0,
        documentId: DOCUMENT_ID,
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
      expect(tabMessages(restarted, "show-toast")).toHaveLength(1),
    );
    expect(tabMessages(restarted, "show-toast")[0]).toMatchObject({
      sessionToken,
      tone: "detected",
      title: "Sent to DigiBot",
    });
    expect(tabMessages(restarted, "picker-stop")).toHaveLength(1);
    expect(store.get(LINK_PICKER_SESSIONS_KEY)).toEqual({});

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
      extensionPageSender("popup.html"),
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
        extensionPageSender("popup.html"),
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
      expect(tabMessages(chromeState, "show-toast")).toHaveLength(1),
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
    expect(tabMessages(chromeState, "show-toast")).toHaveLength(1);
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

    await vi.waitFor(() =>
      expect(tabMessages(chromeState, "show-toast")).toHaveLength(1),
    );
    expect(tabMessages(chromeState, "show-toast")[0]).toMatchObject({
      tone: "error",
      title: "Page link not sent",
      message: "Another page link is still being sent.",
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
      extensionPageSender("popup.html"),
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
      extensionPageSender("popup.html"),
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
      {
        type: "resume-permission",
        pendingId: FIRST_RESULT_ID,
        verificationMode: "api",
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
      { url: `${PAGE_URL}chrome-extension://test/popup.html` },
      { url: "chrome-extension://other/popup.html" },
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
      extensionPageSender("popup.html"),
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
});
