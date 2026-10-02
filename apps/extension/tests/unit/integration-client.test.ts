import {
  RESULT_SCHEMA_VERSION,
  VERIFICATION_POLICY_VERSION,
} from "@provenance-lens/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import contract from "../../../../packages/shared/tests/fixtures/integration-api-v1.json" with { type: "json" };
import {
  installChrome,
  pendingOperationsKey,
  rawOutboxKeys,
  rawOutboxPut,
  resetIntegrationGlobals,
  response,
  session,
  sessionKey,
} from "./integration-harness.js";

const operationId = "123e4567-e89b-42d3-a456-426614174000";
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

function operationInput(
  id = operationId,
  byteLength = 4,
  action: "check" | "download" = "download",
) {
  return {
    version: 1 as const,
    operationId: id,
    action,
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

/** An image Check envelope whose verdict DigiBot already saved. */
function savedCheckEnvelope(input: ReturnType<typeof operationInput>) {
  return {
    ...input,
    action: "check",
    accountId: session.accountId,
    requestedAt: awaitingUpload.requestedAt,
    result: {
      resultRef: "result-fixture-1",
      accountId: session.accountId,
      mediaSha256: input.media.mediaSha256,
      verificationPolicyVersion: VERIFICATION_POLICY_VERSION,
      resultSchemaVersion: RESULT_SCHEMA_VERSION,
      originallyCheckedAt: "2026-09-16T10:00:05.000Z",
      cacheSource: "fresh",
      evidence: {
        verdict: "no_supported_openai_signal",
        summary: "No supported provenance signal was detected.",
        signals: [],
        warnings: [],
        checkedAt: "2026-09-16T10:00:05.000Z",
        requestId: "22222222-2222-4222-8222-222222222222",
      },
    },
    archive: awaitingUpload.archive,
    historySync: {
      state: "synced",
      historyId: "33333333-3333-4333-8333-333333333333",
      error: null,
    },
  };
}

describe("connected integration request contract", () => {
  beforeEach(() => {
    resetIntegrationGlobals();
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

  it("sends the link-download request DigiBot's contract fixture records", async () => {
    const { local } = installChrome();
    await local.set({ [sessionKey]: session });
    const recorded = contract.linkDownload;
    const sent: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit = {}) => {
        sent.push({ url, init });
        return response(recorded.response, recorded.status);
      }),
    );
    const client = await import("../../src/integration-client.js");

    await expect(
      client.createLinkDownload(
        recorded.request.body.operationId,
        recorded.request.body.sourceUrl,
        undefined,
        { output: "mp3" },
      ),
    ).resolves.toEqual(recorded.response);

    expect(sent).toHaveLength(1);
    const [{ url, init } = { url: "", init: {} }] = sent;
    expect(init.method).toBe(recorded.request.method);
    expect(new URL(url).pathname).toBe(recorded.request.path);
    if (typeof init.body !== "string") throw new Error("Expected a JSON body");
    expect(JSON.parse(init.body)).toEqual(recorded.request.body);
  });

  it("sends only the link-download options that are present", async () => {
    const { local } = installChrome();
    await local.set({ [sessionKey]: session });
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit = {}) => {
        if (typeof init.body !== "string")
          throw new Error("Expected a JSON body");
        bodies.push(JSON.parse(init.body));
        return response(contract.linkDownload.response, 202);
      }),
    );
    const client = await import("../../src/integration-client.js");
    const sourceUrl = "https://video.example/watch?v=fixture";
    const clip = { startSeconds: 65, endSeconds: 120 };

    await client.createLinkDownload(operationId, sourceUrl);
    await client.createLinkDownload(operationId, sourceUrl, undefined, {});
    await client.createLinkDownload(operationId, sourceUrl, undefined, {
      output: "mp3",
    });
    await client.createLinkDownload(operationId, sourceUrl, undefined, clip);
    await client.createLinkDownload(operationId, sourceUrl, undefined, {
      output: "mp3",
      ...clip,
    });

    expect(bodies).toEqual([
      { operationId, sourceUrl },
      { operationId, sourceUrl },
      { operationId, sourceUrl, output: "mp3" },
      { operationId, sourceUrl, ...clip },
      { operationId, sourceUrl, output: "mp3", ...clip },
    ]);
  });

  it("refuses a one-sided or inverted clip before any request", async () => {
    const { local } = installChrome();
    await local.set({ [sessionKey]: session });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = await import("../../src/integration-client.js");

    for (const options of [
      { startSeconds: 65 },
      { endSeconds: 120 },
      { startSeconds: 120, endSeconds: 65 },
      { startSeconds: 0, endSeconds: 86_401 },
    ]) {
      await expect(
        client.createLinkDownload(
          operationId,
          "https://video.example/watch?v=fixture",
          undefined,
          options,
        ),
      ).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
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

  it.each([
    ["operation", { operationId: "223e4567-e89b-42d3-a456-426614174000" }],
    ["account", { accountId: "account-fixture-2" }],
  ])(
    "rejects a status from any endpoint that describes another %s",
    async (_what, foreign) => {
      const { local } = installChrome();
      await local.set({ [sessionKey]: session });
      const fetchMock = vi.fn(() =>
        response({ ...awaitingUpload, ...foreign }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const client = await import("../../src/integration-client.js");
      const createdAt = "2026-09-16T10:01:02.000Z";

      const calls = [
        () => client.createIntegrationOperation(operationInput(), createdAt),
        () =>
          client.createAudioSegmentOperation(
            operationId,
            "https://video.example/watch?id=fixture",
            0,
            30,
            createdAt,
          ),
        () =>
          client.uploadIntegrationMedia(
            operationId,
            new Uint8Array([1, 2, 3, 4]),
            "image/png",
          ),
        () => client.getIntegrationOperation(operationId),
        () => client.retryIntegrationOperation(operationId),
        () => client.waitForIntegrationOperation(operationId),
      ];
      for (const call of calls)
        await expect(call()).rejects.toMatchObject({
          code: "integration_operation_mismatch",
          retryable: false,
        });
      expect(fetchMock).toHaveBeenCalledTimes(calls.length);
    },
  );

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

  it("keeps the outbox and pending entry while an upload is still awaited despite a saved result", async () => {
    const { local } = installChrome();
    await local.set({ [sessionKey]: session });
    const client = await import("../../src/integration-client.js");
    const input = operationInput(operationId, 4, "check");
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
    const awaitingCheck = {
      ...awaitingUpload,
      action: "check",
      mediaSha256: input.media.mediaSha256,
    };
    // The PUT answers awaiting_upload with a result: nothing is settled yet.
    const fetchMock = vi.fn((_url: string, init: RequestInit = {}) =>
      response(
        init.method === "PUT"
          ? { ...awaitingCheck, envelope: savedCheckEnvelope(input) }
          : awaitingCheck,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await client.resumePendingIntegrationOperations();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(local.values[pendingOperationsKey]).toMatchObject([{ operationId }]);
    const outbox = await client.getIntegrationOutbox(
      session.accountId,
      operationId,
    );
    expect(outbox?.bytes?.size).toBe(4);
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

  describe("pairing and session lifecycle", () => {
    const pendingPairingKey = "provenanceLens.integration.pendingPairing";
    const pairing = {
      pairId: "pair/fixture 1",
      confirmationCode: "ABC-123",
      expiresAt: "2099-09-16T10:10:00.000Z",
    };
    const pendingPairing = {
      ...pairing,
      verifier: "v".repeat(43),
      deviceName: "Fixture browser",
    };
    const pairedSession = {
      ...session,
      accountId: "account-fixture-2",
      sessionId: "session-fixture-2",
      accessToken: "access-token-fixture-2",
      refreshToken: "refresh-token-fixture-2",
    };

    function call(
      fetchMock: ReturnType<typeof vi.fn>,
      index = 0,
    ): { url: string; init: RequestInit; headers: Headers } {
      const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
      return { url, init, headers: new Headers(init.headers) };
    }

    async function seedConnectedState(local: {
      set: (values: Record<string, unknown>) => Promise<void>;
    }): Promise<void> {
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
        expiresAt: "2099-09-17T10:00:00.000Z",
        bytes: new Blob([new Uint8Array([1, 2, 3, 4])]),
      });
    }

    it("creates a pairing with a fresh verifier and keeps it only in session storage", async () => {
      const { local, session: sessionArea } = installChrome();
      const fetchMock = vi
        .fn()
        .mockImplementation(() => Promise.resolve(response(pairing)));
      vi.stubGlobal("fetch", fetchMock);
      const { createPairing, getPendingPairing } =
        await import("../../src/integration-client.js");

      await expect(createPairing("Fixture browser")).resolves.toEqual(pairing);

      const { url, init, headers } = call(fetchMock);
      expect(url).toMatch(/\/api\/integration\/pairings$/u);
      expect(init.method).toBe("POST");
      expect(init.credentials).toBe("omit");
      expect(headers.get("Authorization")).toBeNull();
      expect(headers.get("X-Integration-Client-Origin")).toBe(
        "chrome-extension://fixture-extension-id",
      );
      if (typeof init.body !== "string") throw new Error("Expected JSON body");
      const body = JSON.parse(init.body) as {
        verifier: string;
        deviceName: string;
      };
      expect(body.deviceName).toBe("Fixture browser");
      expect(body.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(sessionArea.values[pendingPairingKey]).toEqual({
        ...pairing,
        verifier: body.verifier,
        deviceName: "Fixture browser",
      });
      expect(Object.keys(local.values)).toEqual([]);
      await expect(getPendingPairing()).resolves.toEqual({
        ...pairing,
        verifier: body.verifier,
        deviceName: "Fixture browser",
      });

      await createPairing("Fixture browser");
      const { init: secondInit } = call(fetchMock, 1);
      if (typeof secondInit.body !== "string")
        throw new Error("Expected JSON body");
      const second = JSON.parse(secondInit.body) as { verifier: string };
      expect(second.verifier).not.toBe(body.verifier);
    });

    it("drops an expired or malformed pending pairing", async () => {
      const { session: sessionArea } = installChrome();
      const { getPendingPairing } =
        await import("../../src/integration-client.js");

      await sessionArea.set({
        [pendingPairingKey]: {
          ...pendingPairing,
          expiresAt: "2000-01-01T00:00:00.000Z",
        },
      });
      await expect(getPendingPairing()).resolves.toBeNull();
      expect(sessionArea.values[pendingPairingKey]).toBeUndefined();

      await sessionArea.set({
        [pendingPairingKey]: { ...pendingPairing, verifier: undefined },
      });
      await expect(getPendingPairing()).resolves.toBeNull();
    });

    it("refuses to exchange without a live pending pairing", async () => {
      const { session: sessionArea } = installChrome();
      await sessionArea.set({
        [pendingPairingKey]: {
          ...pendingPairing,
          expiresAt: "2000-01-01T00:00:00.000Z",
        },
      });
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const { exchangePairing } =
        await import("../../src/integration-client.js");

      await expect(exchangePairing()).rejects.toMatchObject({
        code: "pairing_expired",
        retryable: false,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("exchanges the verifier and replaces every trace of the previous session", async () => {
      const { local, session: sessionArea } = installChrome();
      await seedConnectedState(local);
      await sessionArea.set({ [pendingPairingKey]: pendingPairing });
      const fetchMock = vi.fn().mockResolvedValue(response(pairedSession));
      vi.stubGlobal("fetch", fetchMock);
      const { exchangePairing, getIntegrationSession } =
        await import("../../src/integration-client.js");

      await expect(exchangePairing()).resolves.toEqual(pairedSession);

      const { url, init, headers } = call(fetchMock);
      expect(url).toMatch(
        /\/api\/integration\/pairings\/pair%2Ffixture%201\/exchange$/u,
      );
      expect(init.method).toBe("POST");
      expect(headers.get("Authorization")).toBeNull();
      expect(init.body).toBe(
        JSON.stringify({ verifier: pendingPairing.verifier }),
      );
      await expect(getIntegrationSession()).resolves.toEqual(pairedSession);
      expect(sessionArea.values[pendingPairingKey]).toBeUndefined();
      expect(local.values[pendingOperationsKey]).toBeUndefined();
      expect(await rawOutboxKeys()).toEqual([]);
    });

    it("keeps the current session when the exchange response is invalid", async () => {
      const { local, session: sessionArea } = installChrome();
      await seedConnectedState(local);
      await sessionArea.set({ [pendingPairingKey]: pendingPairing });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(response({ ...pairedSession, extra: 1 })),
      );
      const { exchangePairing } =
        await import("../../src/integration-client.js");

      await expect(exchangePairing()).rejects.toThrow();
      expect(local.values[sessionKey]).toEqual(session);
      expect(sessionArea.values[pendingPairingKey]).toEqual(pendingPairing);
      expect(await rawOutboxKeys()).toEqual([
        `${session.accountId}:${operationId}`,
      ]);
    });

    it("revokes the server session and clears all local connected state", async () => {
      const { local, session: sessionArea } = installChrome();
      await seedConnectedState(local);
      await sessionArea.set({ [pendingPairingKey]: pendingPairing });
      const fetchMock = vi.fn().mockResolvedValue(response({ ok: true }));
      vi.stubGlobal("fetch", fetchMock);
      const { disconnectIntegration } =
        await import("../../src/integration-client.js");

      await disconnectIntegration();

      const { url, init, headers } = call(fetchMock);
      expect(url).toMatch(/\/api\/integration\/sessions\/session-fixture-1$/u);
      expect(init.method).toBe("DELETE");
      expect(headers.get("Authorization")).toBe("Bearer access-token-fixture");
      expect(local.values[sessionKey]).toBeUndefined();
      expect(local.values[pendingOperationsKey]).toBeUndefined();
      expect(sessionArea.values[pendingPairingKey]).toBeUndefined();
      expect(await rawOutboxKeys()).toEqual([]);
    });

    it.each([
      [
        "an HTTP error",
        () => Promise.resolve(new Response("unavailable", { status: 503 })),
      ],
      ["a network failure", () => Promise.reject(new TypeError("offline"))],
    ])(
      "still clears the local session after %s on the server revoke",
      async (_name, failure) => {
        const { local } = installChrome();
        await seedConnectedState(local);
        const fetchMock = vi.fn(failure);
        vi.stubGlobal("fetch", fetchMock);
        const { disconnectIntegration } =
          await import("../../src/integration-client.js");

        await expect(disconnectIntegration()).resolves.toBeUndefined();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(local.values[sessionKey]).toBeUndefined();
        expect(local.values[pendingOperationsKey]).toBeUndefined();
        expect(await rawOutboxKeys()).toEqual([]);
      },
    );

    it("does not clear a newer session paired while the revoke was in flight", async () => {
      const { local } = installChrome();
      await local.set({ [sessionKey]: session });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          await local.set({ [sessionKey]: pairedSession });
          return response({ ok: true });
        }),
      );
      const { disconnectIntegration } =
        await import("../../src/integration-client.js");

      await disconnectIntegration();

      expect(local.values[sessionKey]).toEqual(pairedSession);
    });

    it("clears leftover pairing state without a request when not connected", async () => {
      const { session: sessionArea } = installChrome();
      await sessionArea.set({ [pendingPairingKey]: pendingPairing });
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const { disconnectIntegration } =
        await import("../../src/integration-client.js");

      await disconnectIntegration();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(sessionArea.values[pendingPairingKey]).toBeUndefined();
    });

    it.each([
      {
        name: "a structured server error keeps its code, message and retry flag",
        reply: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                error: {
                  code: "pairing_rate_limited",
                  message: "Too many pairing requests.",
                  retryable: true,
                },
              }),
              { status: 429 },
            ),
          ),
        error: {
          code: "pairing_rate_limited",
          message: "Too many pairing requests.",
          retryable: true,
          status: 429,
        },
      },
      {
        name: "a structured error without a retry flag is permanent",
        reply: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                error: { code: "forbidden", message: "Not allowed." },
              }),
              { status: 403 },
            ),
          ),
        error: { code: "forbidden", retryable: false, status: 403 },
      },
      {
        name: "an unstructured 5xx is a retryable outage",
        reply: () =>
          Promise.resolve(
            new Response("<html>bad gateway</html>", { status: 502 }),
          ),
        error: {
          code: "integration_unavailable",
          message: "The DigiBot integration server returned HTTP 502.",
          retryable: true,
          status: 502,
        },
      },
      {
        name: "a malformed 4xx error is a permanent request failure",
        reply: () =>
          Promise.resolve(
            new Response(JSON.stringify({ error: { code: "" } }), {
              status: 400,
            }),
          ),
        error: {
          code: "integration_request_failed",
          message: "The DigiBot integration server returned HTTP 400.",
          retryable: false,
          status: 400,
        },
      },
      {
        name: "a network failure is a retryable outage without a status",
        reply: () => Promise.reject(new TypeError("offline")),
        error: {
          code: "integration_unavailable",
          retryable: true,
          status: null,
        },
      },
    ])("maps $name", async ({ reply, error }) => {
      const { session: sessionArea } = installChrome();
      vi.stubGlobal("fetch", vi.fn(reply));
      const { createPairing, IntegrationClientError } =
        await import("../../src/integration-client.js");

      const rejection = createPairing().catch((reason: unknown) => reason);

      await expect(rejection).resolves.toBeInstanceOf(IntegrationClientError);
      await expect(rejection).resolves.toMatchObject(error);
      expect(sessionArea.values[pendingPairingKey]).toBeUndefined();
    });
  });
});
