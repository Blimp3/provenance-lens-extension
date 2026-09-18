import {
  ACTION_ID,
  DISCLOSURE_VERSION,
  makeIndeterminateResult,
} from "@provenance-lens/shared";
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VerificationOutcome } from "../../src/actions/verify-openai-provenance.js";

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
  const tab = { id: TAB_ID, url: PAGE_URL, windowId: WINDOW_ID };
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
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        setAccessLevel: vi.fn().mockResolvedValue(undefined),
      },
    },
    tabs: {
      query: vi.fn().mockResolvedValue([tab]),
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
    executeScript,
    setBadgeText,
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
      {},
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
      {},
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
      {},
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
});
