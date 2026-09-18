import type { HistoryRecord } from "@provenance-lens/shared";
import { beforeEach, describe, expect, it } from "vitest";

import {
  appendHistory,
  clearHistory,
  defaultSettings,
  getHistory,
  getLatestRecord,
  getResult,
  getSettings,
  getWindowLatestRecord,
  deleteHistoryItem,
  replaceHistoryRecord,
  setWindowLatestRecord,
  STORAGE_KEYS,
  saveSettings,
} from "../../src/storage.js";

type MemoryArea = {
  values: Record<string, unknown>;
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (values: Record<string, unknown>) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

function memoryArea(): MemoryArea {
  const values: Record<string, unknown> = {};
  return {
    values,
    get(key) {
      return Promise.resolve({ [key]: values[key] });
    },
    set(next) {
      Object.assign(values, next);
      return Promise.resolve();
    },
    remove(key) {
      delete values[key];
      return Promise.resolve();
    },
  };
}

function delayedMemoryArea(): MemoryArea {
  const area = memoryArea();
  const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  return {
    values: area.values,
    async get(key) {
      await pause();
      return area.get(key);
    },
    async set(next) {
      await pause();
      await area.set(next);
    },
    async remove(key) {
      await pause();
      await area.remove(key);
    },
  };
}

function installStorageMocks(
  local: MemoryArea = memoryArea(),
  session: MemoryArea = memoryArea(),
): void {
  currentLocal = local;
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: { storage: { local, session } },
  });

  let queue = Promise.resolve();
  const request = <T>(
    _name: string,
    callback: () => Promise<T>,
  ): Promise<T> => {
    const operation = queue.then(callback);
    queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request },
  });
}

const record: HistoryRecord = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  actionId: "verify-openai-provenance",
  createdAt: "2026-09-01T10:00:00.000Z",
  sourceHostname: "page.example",
  pageTitle: "Fixture",
  inputKind: "original_file",
  imageSha256: null,
  result: {
    verdict: "indeterminate",
    summary: "The image could not be verified.",
    signals: [],
    warnings: [],
    checkedAt: "2026-09-01T10:00:00.000Z",
    requestId: "123e4567-e89b-42d3-a456-426614174000",
  },
  cache: null,
  errorCode: "backend_unavailable",
  manualFallbackAvailable: false,
  screenshotFallbackAvailable: false,
};

const PRODUCTION_BACKEND_URL = "https://provenance-backend.example.invalid";

let currentLocal: MemoryArea;

describe("history and transient latest retention", () => {
  beforeEach(async () => {
    installStorageMocks();
    await clearHistory();
  });

  it("uses Website review mode for fresh settings", async () => {
    await expect(getSettings()).resolves.toEqual({
      ...defaultSettings,
      backendBaseUrl: PRODUCTION_BACKEND_URL,
    });
  });

  it.each([
    "http://127.0.0.1:8787",
    "http://localhost:8787",
    "http://[::1]:8787",
  ])(
    "migrates the saved loopback backend %s to the public default",
    async (url) => {
      await currentLocal.set({
        [STORAGE_KEYS.settings]: { ...defaultSettings, backendBaseUrl: url },
      });

      await expect(getSettings()).resolves.toMatchObject({
        backendBaseUrl: PRODUCTION_BACKEND_URL,
      });
      expect(currentLocal.values[STORAGE_KEYS.settings]).toMatchObject({
        backendBaseUrl: PRODUCTION_BACKEND_URL,
      });
    },
  );

  it("preserves an explicitly configured remote backend", async () => {
    const settings = {
      ...defaultSettings,
      backendBaseUrl: "https://verify.example/base",
    };
    await currentLocal.set({ [STORAGE_KEYS.settings]: settings });

    await expect(getSettings()).resolves.toEqual(settings);
    expect(currentLocal.values[STORAGE_KEYS.settings]).toEqual(settings);
  });

  it("migrates settings without a verification mode to Website review", async () => {
    await currentLocal.set({
      [STORAGE_KEYS.settings]: {
        backendBaseUrl: "https://verify.example",
        clientToken: "client-token",
        historyRetention: 50,
        screenshotFallbackEnabled: true,
        includePageTitle: false,
        debugMode: true,
        localCacheLimit: 250,
        disclosureVersion: 1,
      },
    });

    await expect(getSettings()).resolves.toMatchObject({
      verificationMode: "website",
      backendBaseUrl: "https://verify.example",
      clientToken: "client-token",
      historyRetention: 50,
      screenshotFallbackEnabled: true,
      includePageTitle: false,
      debugMode: true,
      localCacheLimit: 250,
      disclosureVersion: 1,
    });
  });

  it("persists the optional API mode", async () => {
    await saveSettings({ ...defaultSettings, verificationMode: "api" });
    await expect(getSettings()).resolves.toMatchObject({
      verificationMode: "api",
    });
  });

  it("keeps a bounded transient latest record when history is disabled", async () => {
    await appendHistory(record, 0);
    await expect(getHistory()).resolves.toEqual([]);
    await expect(getLatestRecord()).resolves.toEqual(record);
  });

  it("binds concurrent window popups to their own validated results", async () => {
    const second = {
      ...record,
      id: "123e4567-e89b-42d3-a456-426614174001",
      createdAt: "2026-09-01T10:00:01.000Z",
    };
    await expect(setWindowLatestRecord(7, record)).resolves.toBe(true);
    await expect(setWindowLatestRecord(8, second)).resolves.toBe(true);
    await expect(getWindowLatestRecord(7)).resolves.toEqual(record);
    await expect(getWindowLatestRecord(8)).resolves.toEqual(second);
  });

  it("keeps the newest completion for concurrent checks in one window", async () => {
    const newer = {
      ...record,
      id: "123e4567-e89b-42d3-a456-426614174001",
      createdAt: "2026-09-01T10:00:01.000Z",
    };
    await expect(setWindowLatestRecord(7, newer)).resolves.toBe(true);
    await expect(setWindowLatestRecord(7, record)).resolves.toBe(false);
    await expect(getWindowLatestRecord(7)).resolves.toEqual(newer);
  });

  it("resolves a window-bound result when retained history is disabled", async () => {
    const second = {
      ...record,
      id: "123e4567-e89b-42d3-a456-426614174001",
      createdAt: "2026-09-01T10:00:01.000Z",
    };
    await appendHistory(record, 0);
    await setWindowLatestRecord(7, record);
    await appendHistory(second, 0);
    await expect(getHistory()).resolves.toEqual([]);
    await expect(getResult(record.id)).resolves.toEqual(record);
  });

  it("stores retained history and updates transient latest", async () => {
    await appendHistory(record, 20);
    await expect(getHistory()).resolves.toEqual([record]);
    await expect(getLatestRecord()).resolves.toEqual(record);
  });

  it("clears both retained and transient records", async () => {
    await appendHistory(record, 20);
    await setWindowLatestRecord(7, record);
    await clearHistory();
    await expect(getHistory()).resolves.toEqual([]);
    await expect(getLatestRecord()).resolves.toBeNull();
    await expect(getWindowLatestRecord(7)).resolves.toBeNull();
  });

  it("moves latest to the next retained item after deletion", async () => {
    const second = { ...record, id: "123e4567-e89b-42d3-a456-426614174001" };
    await appendHistory(record, 20);
    await appendHistory(second, 20);
    await setWindowLatestRecord(7, second);
    await deleteHistoryItem(second.id);
    await expect(getLatestRecord()).resolves.toEqual(record);
    await expect(getWindowLatestRecord(7)).resolves.toBeNull();
  });

  it("serializes concurrent appends and deletion without losing or resurrecting records", async () => {
    const local = delayedMemoryArea();
    const session = delayedMemoryArea();
    installStorageMocks(local, session);
    const second = {
      ...record,
      id: "123e4567-e89b-42d3-a456-426614174001",
      createdAt: "2026-09-01T10:00:01.000Z",
    };

    await appendHistory(record, 20);
    await Promise.all([
      appendHistory(second, 20),
      deleteHistoryItem(record.id),
    ]);

    await expect(getHistory()).resolves.toEqual([second]);
    await expect(getLatestRecord()).resolves.toEqual(second);
  });

  it("retains both records from concurrent appends", async () => {
    const local = delayedMemoryArea();
    const session = delayedMemoryArea();
    installStorageMocks(local, session);
    const second = {
      ...record,
      id: "123e4567-e89b-42d3-a456-426614174001",
      createdAt: "2026-09-01T10:00:01.000Z",
    };

    await Promise.all([appendHistory(record, 20), appendHistory(second, 20)]);

    await expect(getHistory()).resolves.toEqual([second, record]);
    await expect(getLatestRecord()).resolves.toEqual(second);
  });

  it("releases the mutation lock after a failed write without losing existing history", async () => {
    const local = delayedMemoryArea();
    const session = delayedMemoryArea();
    installStorageMocks(local, session);
    await appendHistory(record, 20);

    const set = local.set;
    let failNextSet = true;
    local.set = async (next) => {
      if (failNextSet) {
        failNextSet = false;
        throw new Error("storage write failed");
      }
      await set(next);
    };

    await expect(deleteHistoryItem(record.id)).rejects.toThrow(
      "storage write failed",
    );

    const second = {
      ...record,
      id: "123e4567-e89b-42d3-a456-426614174001",
      createdAt: "2026-09-01T10:00:01.000Z",
    };
    await appendHistory(second, 20);

    await expect(getHistory()).resolves.toEqual([second, record]);
    await expect(getLatestRecord()).resolves.toEqual(second);
  });

  it("replaces retained, transient, and window-bound records without resurrecting a deletion", async () => {
    const replacement = {
      ...record,
      result: { ...record.result, summary: "The rechecked result." },
    };
    await appendHistory(record, 0);
    await setWindowLatestRecord(7, record);

    await expect(replaceHistoryRecord(replacement)).resolves.toBe(true);
    await expect(getHistory()).resolves.toEqual([]);
    await expect(getLatestRecord()).resolves.toEqual(replacement);
    await expect(getWindowLatestRecord(7)).resolves.toEqual(replacement);

    await Promise.all([
      replaceHistoryRecord({
        ...replacement,
        result: { ...replacement.result, summary: "A stale recheck." },
      }),
      deleteHistoryItem(record.id),
    ]);
    await expect(getHistory()).resolves.toEqual([]);
    await expect(getLatestRecord()).resolves.toBeNull();
    await expect(getWindowLatestRecord(7)).resolves.toBeNull();
    await expect(replaceHistoryRecord(replacement)).resolves.toBe(false);
  });
});
