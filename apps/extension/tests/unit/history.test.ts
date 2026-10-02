import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  IntegrationOperationStatusSchema,
  type HistoryRecord,
  type IntegrationOperationStatus,
  type IntegrationStats,
  type NormalizedProvenanceResult,
} from "@provenance-lens/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getHistory: vi.fn(),
  deleteHistoryItem: vi.fn(),
  clearHistory: vi.fn(),
  getIntegrationSession: vi.fn(),
  getAllIntegrationHistory: vi.fn(),
  getIntegrationStats: vi.fn(),
  deleteIntegrationHistory: vi.fn(),
  deleteIntegrationArchive: vi.fn(),
  deleteIntegrationMedia: vi.fn(),
}));

vi.mock("../../src/storage.js", () => ({
  STORAGE_KEYS: { history: "provenanceLens.history" },
  clearHistory: mocks.clearHistory,
  deleteHistoryItem: mocks.deleteHistoryItem,
  getHistory: mocks.getHistory,
}));
vi.mock("../../src/integration-client.js", () => ({
  deleteIntegrationArchive: mocks.deleteIntegrationArchive,
  deleteIntegrationHistory: mocks.deleteIntegrationHistory,
  deleteIntegrationMedia: mocks.deleteIntegrationMedia,
  getAllIntegrationHistory: mocks.getAllIntegrationHistory,
  getIntegrationSession: mocks.getIntegrationSession,
  getIntegrationStats: mocks.getIntegrationStats,
}));

type StorageListener = (
  changes: Record<string, unknown>,
  areaName: string,
) => void;

const page = new DOMParser().parseFromString(
  readFileSync(
    resolve(import.meta.dirname, "../../public/history.html"),
    "utf8",
  ),
  "text/html",
);
const checkedAt = "2026-09-16T10:00:05.000Z";
const imageSha256 = "a".repeat(64);
const otherSha256 = "c".repeat(64);

const detected: NormalizedProvenanceResult = {
  verdict: "openai_signal_detected",
  summary: "Detected signals: SynthID.",
  signals: [
    {
      type: "synthid",
      outcome: "detected",
      validationState: null,
      issuer: null,
      model: null,
      generatedAt: null,
    },
  ],
  warnings: [],
  checkedAt,
  requestId: "22222222-2222-4222-8222-222222222222",
};
const noSignal: NormalizedProvenanceResult = {
  verdict: "no_supported_openai_signal",
  summary: "No supported provenance signal was detected.",
  signals: [],
  warnings: [],
  checkedAt,
  requestId: "22222222-2222-4222-8222-222222222223",
};
const indeterminate: NormalizedProvenanceResult = {
  verdict: "indeterminate",
  summary: "The image could not be verified.",
  signals: [],
  warnings: [],
  checkedAt,
  requestId: "22222222-2222-4222-8222-222222222224",
};

function localRecord(
  id: string,
  result: NormalizedProvenanceResult,
  overrides: Partial<HistoryRecord> = {},
): HistoryRecord {
  return {
    id,
    actionId: "verify-openai-provenance",
    createdAt: "2026-09-16T10:00:00.000Z",
    sourceHostname: "images.example",
    pageTitle: "Fixture",
    inputKind: "original_file",
    imageSha256: null,
    result,
    cache: null,
    errorCode: null,
    manualFallbackAvailable: false,
    screenshotFallbackAvailable: false,
    ...overrides,
  };
}

const localRecords = [
  localRecord("11111111-1111-4111-8111-111111111111", detected),
  localRecord("11111111-1111-4111-8111-111111111112", noSignal, {
    actionId: "verify-openai-audio",
    mediaKind: "audio",
    sourceHostname: "",
  }),
  localRecord("11111111-1111-4111-8111-111111111113", indeterminate, {
    inputKind: "screenshot_copy",
    errorCode: "backend_unavailable",
  }),
  localRecord(
    "11111111-1111-4111-8111-111111111114",
    { ...noSignal, requestId: "not-a-request-id" },
    { errorCode: "backend_unavailable" },
  ),
];

const pendingArchive = {
  deliveryState: "pending",
  documentReceipt: null,
  integrityState: "not_checked",
  roundTripSha256: null,
  error: null,
  retryReady: false,
};

/** Builds a status the real API schema accepts. */
function operation(
  operationId: string,
  fields: Record<string, unknown>,
): IntegrationOperationStatus {
  return IntegrationOperationStatusSchema.parse({
    version: 1,
    operationId,
    accountId: "account-fixture-1",
    action: "check",
    state: "completed",
    requestedAt: "2026-09-16T10:00:00.000Z",
    expiresAt: "2099-09-17T10:00:00.000Z",
    mediaSha256: null,
    segment: null,
    envelope: null,
    archive: pendingArchive,
    error: null,
    ...fields,
  });
}

function completedImageCheck(
  operationId: string,
  mediaSha256: string,
  evidence: NormalizedProvenanceResult,
  archive: Record<string, unknown>,
): IntegrationOperationStatus {
  return operation(operationId, {
    mediaSha256,
    archive,
    envelope: {
      version: 1,
      operationId,
      action: "check",
      media: {
        mediaSha256,
        byteLength: 68,
        mimeType: "image/png",
        inputKind: "original",
        audioDurationSeconds: null,
        segment: null,
        fullSourceSha256: null,
      },
      forceRecheck: false,
      accountId: "account-fixture-1",
      requestedAt: "2026-09-16T10:00:00.000Z",
      result: {
        resultRef: `result-${operationId}`,
        accountId: "account-fixture-1",
        mediaSha256,
        verificationPolicyVersion: "openai-content-provenance-v1",
        resultSchemaVersion: 1,
        originallyCheckedAt: checkedAt,
        cacheSource: "fresh",
        evidence,
      },
      archive,
      historySync: {
        state: "synced",
        historyId: operationId.replace(/^3/u, "4"),
        error: null,
      },
    },
  });
}

const savedCheck = completedImageCheck(
  "33333333-3333-4333-8333-333333333331",
  imageSha256,
  detected,
  {
    deliveryState: "confirmed",
    documentReceipt: {
      botId: "123456789",
      chatId: "987654321",
      messageId: "101",
      fileId: "telegram-document-fixture-1",
    },
    integrityState: "verified",
    roundTripSha256: imageSha256,
    error: null,
    retryReady: false,
  },
);
const failedDownload = operation("33333333-3333-4333-8333-333333333332", {
  action: "download",
  state: "failed",
  error: {
    code: "download_failed",
    message: "The original could not be fetched.",
    retryable: false,
  },
});
const queuedSegment = operation("33333333-3333-4333-8333-333333333333", {
  state: "queued",
  segment: { startSeconds: 30, endSeconds: 60 },
  archive: { ...pendingArchive, deliveryState: "not_required" },
});
const unsavedCheck = completedImageCheck(
  "33333333-3333-4333-8333-333333333334",
  otherSha256,
  noSignal,
  {
    ...pendingArchive,
    deliveryState: "failed",
    error: {
      code: "telegram_unavailable",
      message: "Telegram did not confirm the copy.",
      retryable: true,
    },
    retryReady: true,
  },
);
const connectedOperations = [
  savedCheck,
  failedDownload,
  queuedSegment,
  unsavedCheck,
];

const stats: IntegrationStats = {
  period: "all",
  since: null,
  asOf: "2026-09-16T10:05:00.000Z",
  checksRequested: 3,
  checksCompleted: 2,
  checksFailed: 0,
  freshChecks: 1,
  cachedChecks: 1,
  downloadsRequested: 1,
  downloadsConfirmed: 0,
  downloadsFailed: 1,
  uniqueMedia: 2,
  savedOriginals: 1,
  unresolvedArchives: 1,
  legacyDownloads: 0,
};

let storageListener: StorageListener | undefined;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element: ${id}`);
  return found as T;
}

function items(): HTMLLIElement[] {
  return [...document.querySelectorAll<HTMLLIElement>("#history-list > li")];
}

function titles(): string[] {
  return items().map((item) => item.querySelector("strong")?.textContent ?? "");
}

function buttonLabels(item: HTMLLIElement | undefined): string[] {
  return [...(item?.querySelectorAll("button") ?? [])].map(
    (button) => button.textContent ?? "",
  );
}

function click(item: HTMLLIElement | undefined, label: string): void {
  const button = [...(item?.querySelectorAll("button") ?? [])].find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  button.click();
}

function choose(id: "history-filter" | "history-period", value: string): void {
  const select = element<HTMLSelectElement>(id);
  select.value = value;
  select.dispatchEvent(new Event("change"));
}

function statusText(): string {
  return element("history-status").textContent ?? "";
}

async function openPage(): Promise<void> {
  await import("../../src/ui/history.js");
  await vi.waitFor(() => expect(statusText()).not.toBe(""));
}

beforeEach(() => {
  vi.resetModules();
  for (const mock of Object.values(mocks)) mock.mockReset();
  document.body.innerHTML = page.body.innerHTML;
  storageListener = undefined;
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        onChanged: {
          addListener: (listener: StorageListener) => {
            storageListener = listener;
          },
        },
      },
    },
  });
  mocks.deleteHistoryItem.mockResolvedValue(undefined);
  mocks.clearHistory.mockResolvedValue(undefined);
  mocks.deleteIntegrationHistory.mockResolvedValue(undefined);
  mocks.deleteIntegrationArchive.mockResolvedValue(undefined);
  mocks.deleteIntegrationMedia.mockResolvedValue(undefined);
});

describe("standalone history page", () => {
  beforeEach(() => {
    mocks.getIntegrationSession.mockResolvedValue(null);
    mocks.getHistory.mockResolvedValue(localRecords);
  });

  it("renders each saved result with its label, source and details link", async () => {
    await openPage();

    expect(titles()).toEqual([
      "OpenAI provenance detected",
      "No supported OpenAI audio signal detected",
      "The image could not be verified",
      "No supported OpenAI signal detected",
    ]);
    expect(items().map((item) => item.className)).toEqual([
      "history-item result-detected",
      "history-item result-none",
      "history-item result-error",
      "history-item result-none",
    ]);
    const meta = items().map(
      (item) => item.querySelector(".row .muted")?.textContent ?? "",
    );
    expect(meta[0]).toMatch(/^images\.example · .+ · Original image$/u);
    expect(meta[1]).toMatch(/^unknown · .+ · Audio file$/u);
    expect(meta[2]).toMatch(/ · Screenshot copy$/u);
    expect(
      items().map((item) => item.querySelector("p.muted")?.textContent),
    ).toEqual([
      "Detected signals: SynthID.",
      "No supported provenance signal was detected.",
      "The image could not be verified.",
      "The saved result is unavailable.",
    ]);
    expect(items()[0]?.querySelector("a")?.getAttribute("href")).toBe(
      "details.html?id=11111111-1111-4111-8111-111111111111",
    );
    expect(statusText()).toBe("4 of 4 results shown.");
    expect(element("history-stats").textContent).toBe(
      "Standalone history is stored only in this browser.",
    );
    expect(mocks.getAllIntegrationHistory).not.toHaveBeenCalled();
  });

  it.each([
    ["detected", ["OpenAI provenance detected"]],
    [
      "not-detected",
      [
        "No supported OpenAI audio signal detected",
        "No supported OpenAI signal detected",
      ],
    ],
    [
      "error",
      [
        "The image could not be verified",
        "No supported OpenAI signal detected",
      ],
    ],
  ])("filters saved results by %s", async (value, expected) => {
    await openPage();

    choose("history-filter", value);

    await vi.waitFor(() => expect(titles()).toEqual(expected));
    expect(statusText()).toBe(`${expected.length} of 4 results shown.`);
  });

  it("deletes one saved result and re-renders", async () => {
    await openPage();
    mocks.getHistory.mockResolvedValue(
      localRecords.filter((_, index) => index !== 1),
    );

    click(items()[1], "Delete");

    await vi.waitFor(() => expect(statusText()).toBe("3 of 3 results shown."));
    expect(mocks.deleteHistoryItem).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111112",
    );
    expect(titles()).not.toContain("No supported OpenAI audio signal detected");
  });

  it("clears every saved result without touching connected history", async () => {
    await openPage();
    mocks.getHistory.mockResolvedValue([]);

    element<HTMLButtonElement>("clear-history").click();

    await vi.waitFor(() => expect(statusText()).toBe("No saved results."));
    expect(mocks.clearHistory).toHaveBeenCalledOnce();
    expect(mocks.deleteIntegrationHistory).not.toHaveBeenCalled();
    expect(items()).toEqual([]);
  });

  it("re-renders only when local history storage changes", async () => {
    await openPage();
    expect(mocks.getHistory).toHaveBeenCalledTimes(1);

    storageListener?.({ "provenanceLens.settings": {} }, "local");
    storageListener?.({ "provenanceLens.history": {} }, "session");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.getHistory).toHaveBeenCalledTimes(1);

    storageListener?.({ "provenanceLens.history": {} }, "local");
    await vi.waitFor(() => expect(mocks.getHistory).toHaveBeenCalledTimes(2));
  });
});

describe("connected DigiBot history page", () => {
  beforeEach(() => {
    mocks.getIntegrationSession.mockResolvedValue({
      accountId: "account-fixture-1",
    });
    mocks.getAllIntegrationHistory.mockResolvedValue({
      operations: connectedOperations,
      nextCursor: null,
    });
    mocks.getIntegrationStats.mockResolvedValue(stats);
  });

  it("renders connected operations and statistics for the selected period", async () => {
    await openPage();

    expect(mocks.getAllIntegrationHistory).toHaveBeenCalledWith("all");
    expect(mocks.getIntegrationStats).toHaveBeenCalledWith("all");
    expect(mocks.getHistory).not.toHaveBeenCalled();
    expect(statusText()).toBe("4 of 4 connected operations shown.");
    expect(element("history-stats").textContent).toBe(
      "Checks 2/3 (0 failed, 1 fresh, 1 cached) · Downloads 0/1 (1 failed) · " +
        "2 unique media · 1 saved originals · 1 archive unresolved · " +
        "Page links sent to Telegram are delivered in your DigiBot chat and are not counted here.",
    );
    expect(titles()).toEqual([
      "OpenAI provenance detected",
      "Connected operation failed",
      "Connected check queued",
      "No supported OpenAI signal detected",
    ]);
    expect(items().map((item) => item.className)).toEqual([
      "history-item result-detected",
      "history-item result-error",
      "history-item ",
      "history-item result-error",
    ]);
    const meta = items().map(
      (item) => item.querySelector(".row .muted")?.textContent ?? "",
    );
    expect(meta[0]).toMatch(
      new RegExp(`^Check · .+ · SHA-256 ${imageSha256}$`, "u"),
    );
    expect(meta[1]).toMatch(/^Download · .+ · Media digest pending$/u);
    expect(
      items().map((item) => item.querySelector("p.muted")?.textContent),
    ).toEqual([
      "Detected signals: SynthID. Telegram copy saved.",
      "The original could not be fetched.",
      "Segment 30–60 seconds. No Telegram copy requested.",
      "No supported provenance signal was detected. Telegram copy failed.",
    ]);
  });

  it("reloads history and statistics when the period changes", async () => {
    await openPage();
    mocks.getAllIntegrationHistory.mockResolvedValue({
      operations: [savedCheck],
      nextCursor: "cursor-2",
    });

    choose("history-period", "7d");

    await vi.waitFor(() =>
      expect(statusText()).toBe(
        "1 of 1 connected operation shown. Narrow the period to view older operations.",
      ),
    );
    expect(mocks.getAllIntegrationHistory).toHaveBeenLastCalledWith("7d");
    expect(mocks.getIntegrationStats).toHaveBeenLastCalledWith("7d");
  });

  it.each([
    ["detected", ["OpenAI provenance detected"]],
    ["not-detected", ["No supported OpenAI signal detected"]],
    [
      "error",
      ["Connected operation failed", "No supported OpenAI signal detected"],
    ],
  ])("filters connected operations by %s", async (value, expected) => {
    await openPage();

    choose("history-filter", value);

    await vi.waitFor(() => expect(titles()).toEqual(expected));
    expect(statusText()).toBe(
      `${expected.length} of 4 connected operations shown.`,
    );
  });

  it("offers only the delete controls each operation supports", async () => {
    await openPage();

    expect(items().map(buttonLabels)).toEqual([
      ["Delete Telegram copy", "Delete history", "Delete media + history"],
      ["Delete history"],
      ["Delete history"],
      ["Delete history", "Delete media + history"],
    ]);
  });

  it.each([
    {
      label: "Delete Telegram copy",
      mock: mocks.deleteIntegrationArchive,
      argument: imageSha256,
    },
    {
      label: "Delete history",
      mock: mocks.deleteIntegrationHistory,
      argument: savedCheck.operationId,
    },
    {
      label: "Delete media + history",
      mock: mocks.deleteIntegrationMedia,
      argument: imageSha256,
    },
  ])(
    "$label deletes only its own target and re-renders",
    async ({ label, mock, argument }) => {
      await openPage();

      click(items()[0], label);

      await vi.waitFor(() =>
        expect(mocks.getAllIntegrationHistory).toHaveBeenCalledTimes(2),
      );
      expect(mock).toHaveBeenCalledExactlyOnceWith(argument);
      const deletes = [
        mocks.deleteIntegrationArchive,
        mocks.deleteIntegrationHistory,
        mocks.deleteIntegrationMedia,
      ];
      expect(
        deletes.filter((candidate) => candidate.mock.calls.length),
      ).toEqual([mock]);
    },
  );

  it.each([
    {
      label: "Delete Telegram copy",
      mock: mocks.deleteIntegrationArchive,
      message: "The Telegram copy could not be deleted.",
    },
    {
      label: "Delete history",
      mock: mocks.deleteIntegrationHistory,
      message: "The connected history item could not be deleted.",
    },
    {
      label: "Delete media + history",
      mock: mocks.deleteIntegrationMedia,
      message: "The connected media and its history could not be deleted.",
    },
  ])(
    "reports a failed $label and keeps the list",
    async ({ label, mock, message }) => {
      await openPage();
      mock.mockRejectedValue(new Error("offline"));

      click(items()[0], label);

      await vi.waitFor(() => expect(statusText()).toBe(message));
      expect(element("history-status").className).toBe("status error");
      expect(items()).toHaveLength(4);
    },
  );

  it("clears connected history one operation at a time for the selected period", async () => {
    await openPage();
    choose("history-period", "30d");
    await vi.waitFor(() =>
      expect(mocks.getIntegrationStats).toHaveBeenLastCalledWith("30d"),
    );
    mocks.getAllIntegrationHistory.mockClear();

    element<HTMLButtonElement>("clear-history").click();

    await vi.waitFor(() =>
      expect(mocks.deleteIntegrationHistory).toHaveBeenCalledTimes(4),
    );
    expect(mocks.deleteIntegrationHistory.mock.calls).toEqual(
      connectedOperations.map(({ operationId }) => [operationId]),
    );
    expect(mocks.getAllIntegrationHistory).toHaveBeenNthCalledWith(1, "30d");
    expect(mocks.clearHistory).not.toHaveBeenCalled();
  });

  it("reports a connected clear failure", async () => {
    await openPage();
    mocks.deleteIntegrationHistory.mockRejectedValue(new Error("offline"));

    element<HTMLButtonElement>("clear-history").click();

    await vi.waitFor(() =>
      expect(statusText()).toBe("Connected history could not be cleared."),
    );
    expect(mocks.deleteIntegrationHistory).toHaveBeenCalledOnce();
    expect(element("history-status").className).toBe("status error");
  });

  it("shows an error instead of local history when DigiBot cannot be reached", async () => {
    mocks.getAllIntegrationHistory.mockRejectedValue(new Error("offline"));

    await openPage();

    expect(statusText()).toBe(
      "DigiBot history could not be loaded. Check the connection in Settings.",
    );
    expect(element("history-status").className).toBe("status error");
    expect(element("history-stats").textContent).toBe(
      "Connected statistics are unavailable.",
    );
    expect(items()).toEqual([]);
    expect(mocks.getHistory).not.toHaveBeenCalled();
  });
});
