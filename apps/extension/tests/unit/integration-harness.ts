import "fake-indexeddb/auto";

import { Blob as NodeBlob } from "node:buffer";

import { IDBFactory } from "fake-indexeddb";
import { vi } from "vitest";

// Shared chrome, fetch and IndexedDB fakes for the connected-mode tests.

export const session = {
  tokenType: "Bearer" as const,
  accountId: "account-fixture-1",
  sessionId: "session-fixture-1",
  accessToken: "access-token-fixture",
  accessExpiresAt: "2099-09-16T10:15:00.000Z",
  refreshToken: "refresh-token-fixture",
  refreshExpiresAt: "2099-09-23T10:00:00.000Z",
  absoluteExpiresAt: "2099-10-16T10:00:00.000Z",
};

export const sessionKey = "provenanceLens.integration.session";
export const pendingOperationsKey =
  "provenanceLens.integration.pendingOperations";

export type MemoryArea = {
  values: Record<string, unknown>;
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (values: Record<string, unknown>) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

/** Fresh modules, mocks, globals and IndexedDB for each test. */
export function resetIntegrationGlobals(): void {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: new IDBFactory(),
  });
  vi.stubGlobal("Blob", NodeBlob);
}

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

export function installChrome(): {
  local: MemoryArea;
  session: MemoryArea;
} {
  const local = memoryArea();
  const sessionArea = memoryArea();
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      runtime: { id: "fixture-extension-id" },
      storage: { local, session: sessionArea },
    },
  });
  const lockTails = new Map<string, Promise<unknown>>();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request<T>(name: string, callback: () => Promise<T>): Promise<T> {
        const result = (lockTails.get(name) ?? Promise.resolve()).then(
          callback,
        );
        lockTails.set(
          name,
          result.then(
            () => undefined,
            () => undefined,
          ),
        );
        return result;
      },
    },
  });
  return { local, session: sessionArea };
}

export function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function rawOutboxPut(key: string, value: unknown): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("provenance-lens-integration-outbox", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("operations");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Unable to open test outbox."));
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("operations", "readwrite");
    transaction.objectStore("operations").put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Unable to write test outbox."));
  });
  database.close();
}

export async function rawOutboxKeys(): Promise<IDBValidKey[]> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("provenance-lens-integration-outbox", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("operations");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Unable to open test outbox."));
  });
  const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
    const request = database
      .transaction("operations", "readonly")
      .objectStore("operations")
      .getAllKeys();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Unable to read test outbox."));
  });
  database.close();
  return keys;
}
