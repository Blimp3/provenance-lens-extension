import "fake-indexeddb/auto";

import { Blob as NodeBlob } from "node:buffer";

import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const session = {
  tokenType: "Bearer" as const,
  accountId: "account-fixture-1",
  sessionId: "session-fixture-1",
  accessToken: "access-token-fixture",
  accessExpiresAt: "2099-09-16T10:15:00.000Z",
  refreshToken: "refresh-token-fixture",
  refreshExpiresAt: "2099-09-23T10:00:00.000Z",
  absoluteExpiresAt: "2099-10-16T10:00:00.000Z",
};

const operationId = "123e4567-e89b-42d3-a456-426614174000";
const sessionKey = "provenanceLens.integration.session";
const pendingOperationsKey = "provenanceLens.integration.pendingOperations";
const awaitingUpload = {
  version: 1,
  operationId,
  accountId: session.accountId,
  action: "download",
  state: "awaiting_upload",
  requestedAt: "2026-09-16T10:00:00.000Z",
  expiresAt: "2026-09-17T10:00:00.000Z",
  mediaSha256: null,
  segment: null,
  envelope: null,
  archive: {
    deliveryState: "pending",
    documentReceipt: null,
    integrityState: "not_checked",
    roundTripSha256: null,
    error: null,
    retryReady: false,
  },
  error: null,
};

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

function installChrome(): {
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

function response(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function operationInput(id = operationId, byteLength = 4) {
  return {
    version: 1 as const,
    operationId: id,
    action: "download" as const,
    media: {
      mediaSha256: "a".repeat(64),
      byteLength,
      mimeType: "image/png" as const,
      inputKind: "original" as const,
      audioDurationSeconds: null,
      segment: null,
      fullSourceSha256: null,
    },
    forceRecheck: false,
  };
}

async function rawOutboxPut(key: string, value: unknown): Promise<void> {
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

async function rawOutboxKeys(): Promise<IDBValidKey[]> {
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

describe("connected integration request contract", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: new IDBFactory(),
    });
    vi.stubGlobal("Blob", NodeBlob);
  });

  it("sends the account session, created-at replay key, and pinned client origin", async () => {
    const { local } = installChrome();
    await local.set({ "provenanceLens.integration.session": session });
    const fetchMock = vi.fn().mockResolvedValue(response(awaitingUpload));
    vi.stubGlobal("fetch", fetchMock);
    const { createIntegrationOperation } =
      await import("../../src/integration-client.js");
    const createdAt = "2026-09-16T10:01:02.000Z";
    await createIntegrationOperation(
      {
        version: 1,
        operationId,
        action: "download",
        media: {
          mediaSha256: "a".repeat(64),
          byteLength: 4,
          mimeType: "image/png",
          inputKind: "original",
          audioDurationSeconds: null,
          segment: null,
          fullSourceSha256: null,
        },
        forceRecheck: false,
      },
      createdAt,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/integration/operations");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer access-token-fixture");
    expect(headers.get("X-Integration-Created-At")).toBe(createdAt);
    expect(headers.get("X-Integration-Client-Origin")).toBe(
      "chrome-extension://fixture-extension-id",
    );
  });

  it("uses the same replay timestamp header for video segment registration", async () => {
    const { local } = installChrome();
    await local.set({ "provenanceLens.integration.session": session });
    const fetchMock = vi.fn().mockResolvedValue(response(awaitingUpload));
    vi.stubGlobal("fetch", fetchMock);
    const { createAudioSegmentOperation } =
      await import("../../src/integration-client.js");
    const createdAt = "2026-09-16T10:02:03.000Z";
    await createAudioSegmentOperation(
      operationId,
      "https://video.example/watch?id=fixture",
      30,
      60,
      createdAt,
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("X-Integration-Created-At")).toBe(createdAt);
    if (typeof init.body !== "string") throw new Error("Expected JSON body");
    expect(JSON.parse(init.body)).toEqual({
      operationId,
      sourceUrl: "https://video.example/watch?id=fixture",
      startSeconds: 30,
      endSeconds: 60,
    });
  });

  it("rejects every operation stage when its durable session changed", async () => {
    const { local } = installChrome();
    await local.set({ [sessionKey]: session });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = await import("../../src/integration-client.js");
    const input = operationInput();
    const createdAt = "2026-09-16T10:01:02.000Z";
    await client.saveIntegrationOutbox({
      accountId: session.accountId,
      sessionId: session.sessionId,
      operationId,
      createdAt,
      expiresAt: "2099-09-17T10:00:00.000Z",
      input,
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    await client.addPendingIntegrationOperation({
      accountId: session.accountId,
      sessionId: session.sessionId,
      operationId,
      createdAt,
    });
    await local.set({
      [sessionKey]: {
        ...session,
        accountId: "account-fixture-2",
        sessionId: "session-fixture-2",
        accessToken: "access-token-fixture-2",
        refreshToken: "refresh-token-fixture-2",
      },
    });

    const calls = [
      () => client.createIntegrationOperation(input, createdAt),
      () =>
        client.uploadIntegrationMedia(
          operationId,
          new Uint8Array([1, 2, 3, 4]),
          "image/png",
        ),
      () =>
        client.createAudioSegmentOperation(
          operationId,
          "https://video.example/watch?id=fixture",
          0,
          30,
          createdAt,
        ),
      () => client.getIntegrationOperation(operationId),
      () => client.retryIntegrationOperation(operationId),
      () => client.waitForIntegrationOperation(operationId),
    ];
    for (const call of calls)
      await expect(call()).rejects.toMatchObject({
        code: "integration_session_changed",
        retryable: false,
      });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects durable bytes saved after the initiating account changed", async () => {
    const { local } = installChrome();
    await local.set({ [sessionKey]: session });
    const client = await import("../../src/integration-client.js");
    await local.set({
      [sessionKey]: {
        ...session,
        accountId: "account-fixture-2",
        sessionId: "session-fixture-2",
        accessToken: "access-token-fixture-2",
        refreshToken: "refresh-token-fixture-2",
      },
    });

    await expect(
      client.saveIntegrationOutbox({
        accountId: session.accountId,
        sessionId: session.sessionId,
        operationId,
        createdAt: "2026-09-16T10:01:02.000Z",
        expiresAt: "2099-09-17T10:00:00.000Z",
        input: operationInput(),
        bytes: new Uint8Array([1, 2, 3, 4]),
      }),
    ).rejects.toMatchObject({
      code: "integration_session_changed",
      retryable: false,
    });
    expect(await rawOutboxKeys()).toEqual([]);
  });

  it("does not upload old outbox bytes after the account switches mid-recovery", async () => {
    const { local } = installChrome();
    await local.set({ [sessionKey]: session });
    const client = await import("../../src/integration-client.js");
    const input = operationInput();
    const createdAt = "2026-09-16T10:01:02.000Z";
    await client.saveIntegrationOutbox({
      accountId: session.accountId,
      sessionId: session.sessionId,
      operationId,
      createdAt,
      expiresAt: "2099-09-17T10:00:00.000Z",
      input,
      bytes: new Uint8Array([1, 2, 3, 4]),
    });
    await client.addPendingIntegrationOperation({
      accountId: session.accountId,
      sessionId: session.sessionId,
      operationId,
      createdAt,
    });
    const fetchMock = vi.fn(async () => {
      await local.set({
        [sessionKey]: {
          ...session,
          accountId: "account-fixture-2",
          sessionId: "session-fixture-2",
          accessToken: "access-token-fixture-2",
          refreshToken: "refresh-token-fixture-2",
        },
      });
      return response(awaitingUpload);
    });
    vi.stubGlobal("fetch", fetchMock);

    await client.resumePendingIntegrationOperations();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(local.values[pendingOperationsKey]).toEqual([]);
    expect(
      await client.getIntegrationOutbox(session.accountId, operationId),
    ).toBeNull();
  });

  it("discards outbox bytes created by a different device session", async () => {
    const { local } = installChrome();
    await local.set({
      [sessionKey]: session,
      [pendingOperationsKey]: [
        {
          accountId: session.accountId,
          sessionId: session.sessionId,
          operationId,
          createdAt: "2026-09-16T10:01:02.000Z",
        },
      ],
    });
    await rawOutboxPut(`${session.accountId}:${operationId}`, {
      accountId: session.accountId,
      sessionId: "different-device-session",
      operationId,
      createdAt: "2026-09-16T10:01:02.000Z",
      expiresAt: "2099-09-17T10:00:00.000Z",
      input: operationInput(),
      bytes: new Blob([new Uint8Array([1, 2, 3, 4])]),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = await import("../../src/integration-client.js");

    await client.resumePendingIntegrationOperations();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(local.values[pendingOperationsKey]).toEqual([]);
    expect(
      await client.getIntegrationOutbox(session.accountId, operationId),
    ).toBeNull();
  });

  it("serializes pending removal with a concurrent operation add", async () => {
    const { local } = installChrome();
    await local.set({
      [sessionKey]: session,
      [pendingOperationsKey]: [
        {
          accountId: session.accountId,
          sessionId: session.sessionId,
          operationId,
          createdAt: "2026-09-16T10:01:02.000Z",
        },
      ],
    });
    const originalSet = local.set;
    let removalStarted!: () => void;
    let releaseRemoval!: () => void;
    const started = new Promise<void>((resolve) => {
      removalStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    let delayed = false;
    local.set = async (values) => {
      const pending = values[pendingOperationsKey];
      if (!delayed && Array.isArray(pending) && pending.length === 0) {
        delayed = true;
        removalStarted();
        await release;
      }
      await originalSet(values);
    };
    const client = await import("../../src/integration-client.js");
    const removing = client.removePendingIntegrationOperation(
      session.accountId,
      operationId,
    );
    await started;
    const nextId = "223e4567-e89b-42d3-a456-426614174000";
    const adding = client.addPendingIntegrationOperation({
      accountId: session.accountId,
      sessionId: session.sessionId,
      operationId: nextId,
      createdAt: "2026-09-16T10:02:02.000Z",
    });
    releaseRemoval();
    await Promise.all([removing, adding]);

    expect(local.values[pendingOperationsKey]).toEqual([
      {
        accountId: session.accountId,
        sessionId: session.sessionId,
        operationId: nextId,
        createdAt: "2026-09-16T10:02:02.000Z",
      },
    ]);
  });

  it("does not restore a session removed while refresh is in flight", async () => {
    const { local } = installChrome();
    const expiredSession = {
      ...session,
      accessExpiresAt: "2000-01-01T00:00:00.000Z",
    };
    const refreshedSession = {
      ...session,
      accessToken: "access-token-refreshed",
      refreshToken: "refresh-token-refreshed",
    };
    await local.set({ [sessionKey]: expiredSession });
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("/sessions/refresh");
      await local.remove(sessionKey);
      return response(refreshedSession);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { createIntegrationOperation } =
      await import("../../src/integration-client.js");

    await expect(
      createIntegrationOperation(operationInput(), "2026-09-16T10:01:02.000Z"),
    ).rejects.toMatchObject({ code: "integration_session_changed" });
    expect(local.values[sessionKey]).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serializes refresh across callers and reuses the rotated session", async () => {
    const { local } = installChrome();
    const expiredSession = {
      ...session,
      accessExpiresAt: "2000-01-01T00:00:00.000Z",
    };
    const refreshedSession = {
      ...session,
      accessToken: "access-token-refreshed",
      accessExpiresAt: "2099-09-16T10:15:00.000Z",
      refreshToken: "refresh-token-refreshed",
    };
    await local.set({ [sessionKey]: expiredSession });
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      void init;
      return Promise.resolve(
        url.includes("/sessions/refresh")
          ? response(refreshedSession)
          : response(awaitingUpload),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const { createIntegrationOperation } =
      await import("../../src/integration-client.js");

    await Promise.all([
      createIntegrationOperation(operationInput(), "2026-09-16T10:01:02.000Z"),
      createIntegrationOperation(operationInput(), "2026-09-16T10:01:02.000Z"),
    ]);

    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).includes("/sessions/refresh"),
      ),
    ).toHaveLength(1);
    const operationCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/operations"),
    );
    expect(operationCalls).toHaveLength(2);
    for (const [, init] of operationCalls) {
      if (!init) throw new Error("Expected request init");
      expect(new Headers(init.headers).get("Authorization")).toBe(
        "Bearer access-token-refreshed",
      );
    }
  });

  it("sweeps expired outbox entries for every account without a session", async () => {
    installChrome();
    await rawOutboxPut("account-a:old", {
      expiresAt: "2000-01-01T00:00:00.000Z",
      bytes: new Blob([new Uint8Array([1])]),
    });
    await rawOutboxPut("account-b:live", {
      expiresAt: "2099-09-16T09:00:00.000Z",
      bytes: new Blob([new Uint8Array([2])]),
    });
    const { resumePendingIntegrationOperations } =
      await import("../../src/integration-client.js");

    await resumePendingIntegrationOperations();

    expect(await rawOutboxKeys()).toEqual(["account-b:live"]);
  });

  it("atomically bounds the outbox entry count", async () => {
    const { local } = installChrome();
    await local.set({ [sessionKey]: session });
    const { saveIntegrationSegmentOutbox } =
      await import("../../src/integration-client.js");
    const saves = Array.from({ length: 21 }, (_, index) =>
      saveIntegrationSegmentOutbox({
        accountId: session.accountId,
        sessionId: session.sessionId,
        operationId: `operation-${index}`,
        createdAt: "2026-09-16T10:01:02.000Z",
        expiresAt: "2099-09-17T10:00:00.000Z",
        sourceUrl: "https://video.example/watch?id=fixture",
        startSeconds: 0,
        endSeconds: 30,
      }),
    );

    const results = await Promise.allSettled(saves);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(20);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: { code: "integration_outbox_limit", retryable: false },
    });
    expect(await rawOutboxKeys()).toHaveLength(20);
  });

  it("bounds aggregate outbox bytes across operations", async () => {
    const { local } = installChrome();
    await local.set({ [sessionKey]: session });
    await rawOutboxPut("account-other:large", {
      expiresAt: "2099-09-17T10:00:00.000Z",
      bytes: new Blob([new Uint8Array(49_000_000)]),
    });
    const { saveIntegrationOutbox } =
      await import("../../src/integration-client.js");
    const bytes = new Uint8Array(4_194_305);

    await expect(
      saveIntegrationOutbox({
        accountId: session.accountId,
        sessionId: session.sessionId,
        operationId,
        createdAt: "2026-09-16T10:01:02.000Z",
        expiresAt: "2099-09-17T10:00:00.000Z",
        input: operationInput(operationId, bytes.byteLength),
        bytes,
      }),
    ).rejects.toMatchObject({
      code: "integration_outbox_limit",
      retryable: false,
    });
    expect(await rawOutboxKeys()).toEqual(["account-other:large"]);
  });
});
