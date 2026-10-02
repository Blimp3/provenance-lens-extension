import { createHash } from "node:crypto";

import {
  LINK_ACTION_ID,
  RESULT_SCHEMA_VERSION,
  VERIFICATION_POLICY_VERSION,
  type ImageSelection,
  type IntegrationOperationInputV1,
} from "@provenance-lens/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ImageRetrievalContext } from "../../src/actions/verify-openai-provenance.js";
import { STORAGE_KEYS } from "../../src/storage.js";
import {
  installChrome,
  pendingOperationsKey,
  rawOutboxKeys,
  resetIntegrationGlobals,
  response,
  session,
  sessionKey,
  type MemoryArea,
} from "./integration-harness.js";

type ApiCall = {
  method: string;
  path: string;
  headers: Headers;
  body: BodyInit | null | undefined;
  signal: AbortSignal | null | undefined;
};

const otherSession = {
  ...session,
  accountId: "account-fixture-2",
  sessionId: "session-fixture-2",
  accessToken: "access-token-fixture-2",
  refreshToken: "refresh-token-fixture-2",
};
const requestedAt = "2026-09-16T10:00:00.000Z";
const checkedAt = "2026-09-16T10:00:05.000Z";
const pendingArchive = {
  deliveryState: "pending",
  documentReceipt: null,
  integrityState: "not_checked",
  roundTripSha256: null,
  error: null,
  retryReady: false,
};

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const selection: ImageSelection = {
  url: "https://page.example/image.png",
  sourceKind: "img",
  pageOrigin: "https://page.example",
  sourceHostname: "page.example",
  pageTitle: "Fixture page",
  rect: {
    x: 0,
    y: 0,
    width: 2,
    height: 2,
    viewportWidth: 100,
    viewportHeight: 100,
    devicePixelRatio: 1,
  },
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Routes the global fetch to a fake DigiBot integration API. */
function serveDigiBot(
  route: (call: ApiCall) => Response | Promise<Response>,
): ApiCall[] {
  const calls: ApiCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit = {}) => {
      const call: ApiCall = {
        method: init.method ?? "GET",
        path: new URL(url).pathname.replace(/^\/api\/integration/u, ""),
        headers: new Headers(init.headers),
        body: init.body,
        signal: init.signal,
      };
      calls.push(call);
      return Promise.resolve().then(() => route(call));
    }),
  );
  return calls;
}

function routes(calls: ApiCall[]): string[] {
  return calls.map(({ method, path }) => `${method} ${path}`);
}

function jsonBody<T>(call: ApiCall | undefined): T {
  if (typeof call?.body !== "string") throw new Error("Expected a JSON body");
  return JSON.parse(call.body) as T;
}

async function uploadedBytes(call: ApiCall | undefined): Promise<number[]> {
  if (!(call?.body instanceof Blob)) throw new Error("Expected a Blob body");
  return [...new Uint8Array(await call.body.arrayBuffer())];
}

function imageRetrieval(onFetch?: () => Promise<void>): ImageRetrievalContext {
  return {
    fetchImpl: async () => {
      await onFetch?.();
      return new Response(png.slice(), {
        headers: { "content-type": "image/png" },
      });
    },
  };
}

function audioFile(): File {
  const sampleRate = 8_000;
  const dataSize = sampleRate * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1)
      view.setUint8(offset + index, text.charCodeAt(index));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, dataSize, true);
  return new File([bytes], "voice.wav", { type: "audio/wav" });
}

function pendingStatus(
  input: IntegrationOperationInputV1,
  state: "awaiting_upload" | "queued" | "processing",
) {
  return {
    version: 1,
    operationId: input.operationId,
    accountId: session.accountId,
    action: input.action,
    state,
    requestedAt,
    expiresAt: "2099-09-17T10:00:00.000Z",
    mediaSha256: input.media.mediaSha256,
    segment: input.media.segment,
    envelope: null,
    archive: pendingArchive,
    error: null,
  };
}

function completedStatus(input: IntegrationOperationInputV1) {
  const archive = input.media.mimeType.startsWith("audio/")
    ? { ...pendingArchive, deliveryState: "not_required" }
    : {
        deliveryState: "confirmed",
        documentReceipt: {
          botId: "123456789",
          chatId: "987654321",
          messageId: "101",
          fileId: "telegram-document-fixture-1",
        },
        integrityState: "verified",
        roundTripSha256: input.media.mediaSha256,
        error: null,
        retryReady: false,
      };
  const result =
    input.action === "check"
      ? {
          resultRef: "result-fixture-1",
          accountId: session.accountId,
          mediaSha256: input.media.mediaSha256,
          verificationPolicyVersion: VERIFICATION_POLICY_VERSION,
          resultSchemaVersion: RESULT_SCHEMA_VERSION,
          originallyCheckedAt: checkedAt,
          cacheSource: "fresh",
          evidence: {
            verdict: "no_supported_openai_signal",
            summary: "No supported provenance signal was detected.",
            signals: [],
            warnings: [],
            checkedAt,
            requestId: "22222222-2222-4222-8222-222222222222",
          },
        }
      : null;
  return {
    ...pendingStatus(input, "queued"),
    state: "completed",
    envelope: {
      ...input,
      accountId: session.accountId,
      requestedAt,
      result,
      archive,
      historySync: {
        state: "synced",
        historyId: "33333333-3333-4333-8333-333333333333",
        error: null,
      },
    },
    archive,
  };
}

/**
 * A Check after DigiBot's "save evidence" step: the verdict is saved while the
 * operation is still processing (an image's Telegram archive is in flight).
 */
function processingWithVerdictStatus(input: IntegrationOperationInputV1) {
  const completed = completedStatus(input);
  const archive = input.media.mimeType.startsWith("audio/")
    ? completed.archive
    : pendingArchive;
  return {
    ...completed,
    state: "processing",
    envelope: { ...completed.envelope, archive },
    archive,
  };
}

/** A Download being archived: its envelope is reported early and never carries a result. */
function archivingDownloadStatus(input: IntegrationOperationInputV1) {
  const completed = completedStatus(input);
  return {
    ...pendingStatus(input, "processing"),
    envelope: { ...completed.envelope, archive: pendingArchive },
  };
}

function apiError(status: number, code: string, retryable: boolean) {
  return response(
    { error: { code, message: "Fixture failure.", retryable } },
    status,
  );
}

function unreachable(): Promise<Response> {
  return Promise.reject(new TypeError("Failed to fetch"));
}

async function connect(): Promise<MemoryArea> {
  const { local } = installChrome();
  await local.set({ [sessionKey]: session });
  return local;
}

function pendingIds(local: MemoryArea): string[] {
  const pending = (local.values[pendingOperationsKey] ?? []) as {
    operationId: string;
  }[];
  return pending.map(({ operationId }) => operationId);
}

describe("connected image actions", () => {
  beforeEach(() => {
    resetIntegrationGlobals();
  });

  it("requires a connected session before reading the image", async () => {
    installChrome();
    const calls = serveDigiBot(() => response({}));
    const fetchImpl = vi.fn();
    const { runIntegratedImageAction } =
      await import("../../src/actions/integration-image.js");

    await expect(
      runIntegratedImageAction("check", selection, { fetchImpl }),
    ).rejects.toThrow(
      "Connect Provenance Lens to DigiBot before using connected actions.",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("hashes, stores, registers, uploads, and waits for the exact image bytes", async () => {
    const local = await connect();
    const client = await import("../../src/integration-client.js");
    const { runIntegratedImageAction } =
      await import("../../src/actions/integration-image.js");
    let operationId = "";
    const seen: Record<string, unknown> = {};
    const calls = serveDigiBot(async (call) => {
      if (call.method === "POST" && call.path === "/operations") {
        const input = jsonBody<IntegrationOperationInputV1>(call);
        operationId = input.operationId;
        seen["outboxAtCreate"] = await rawOutboxKeys();
        seen["pendingAtCreate"] = pendingIds(local);
        return response(pendingStatus(input, "awaiting_upload"));
      }
      const input = jsonBody<IntegrationOperationInputV1>(calls[0]);
      if (call.method === "PUT")
        return response(pendingStatus(input, "processing"));
      const outbox = await client.getIntegrationOutbox(
        session.accountId,
        operationId,
      );
      seen["outboxBytesAtWait"] = outbox?.bytes;
      return response(completedStatus(input));
    });

    const outcome = await runIntegratedImageAction(
      "download",
      selection,
      imageRetrieval(),
    );

    expect(routes(calls)).toEqual([
      "POST /operations",
      `PUT /operations/${operationId}/media`,
      `GET /operations/${operationId}`,
    ]);
    const input = jsonBody<IntegrationOperationInputV1>(calls[0]);
    expect(input).toEqual({
      version: 1,
      operationId,
      action: "download",
      media: {
        mediaSha256: sha256(png),
        byteLength: png.byteLength,
        mimeType: "image/png",
        inputKind: "original",
        audioDurationSeconds: null,
        segment: null,
        fullSourceSha256: null,
      },
      forceRecheck: false,
    });
    expect(calls[0]?.headers.get("X-Integration-Created-At")).toMatch(
      /^\d{4}-\d{2}-\d{2}T/u,
    );
    expect(seen["outboxAtCreate"]).toEqual([
      `${session.accountId}:${operationId}`,
    ]);
    expect(seen["pendingAtCreate"]).toEqual([operationId]);
    expect(calls[1]?.headers.get("Content-Type")).toBe("image/png");
    expect(await uploadedBytes(calls[1])).toEqual([...png]);
    expect(seen["outboxBytesAtWait"]).toBeNull();
    expect(outcome.status).toMatchObject({ operationId, state: "completed" });
    expect(outcome).toEqual({
      status: outcome.status,
      imageSha256: sha256(png),
      selection: { sourceHostname: "page.example", pageTitle: "Fixture page" },
    });
    expect(pendingIds(local)).toEqual([]);
    expect(await rawOutboxKeys()).toEqual([]);
  });

  it("skips the upload and the wait when DigiBot already has the result", async () => {
    const local = await connect();
    const calls = serveDigiBot((call) =>
      response(completedStatus(jsonBody<IntegrationOperationInputV1>(call))),
    );
    const { runIntegratedImageAction } =
      await import("../../src/actions/integration-image.js");

    const outcome = await runIntegratedImageAction(
      "check",
      selection,
      imageRetrieval(),
    );

    expect(routes(calls)).toEqual(["POST /operations"]);
    expect(outcome.status.state).toBe("completed");
    expect(pendingIds(local)).toEqual([]);
    expect(await rawOutboxKeys()).toEqual([]);
  });

  it("rejects and cleans up a status that describes different media", async () => {
    const local = await connect();
    const calls = serveDigiBot((call) => {
      const input = jsonBody<IntegrationOperationInputV1>(call);
      return response(
        completedStatus({
          ...input,
          media: { ...input.media, mediaSha256: "f".repeat(64) },
        }),
      );
    });
    const { runIntegratedImageAction } =
      await import("../../src/actions/integration-image.js");

    await expect(
      runIntegratedImageAction("check", selection, imageRetrieval()),
    ).rejects.toMatchObject({
      code: "integration_media_mismatch",
      retryable: false,
    });

    expect(routes(calls)).toEqual(["POST /operations"]);
    expect(pendingIds(local)).toEqual([]);
    expect(await rawOutboxKeys()).toEqual([]);
  });

  it("rejects and cleans up a verdict for different media that arrives after the wait", async () => {
    const local = await connect();
    const calls = serveDigiBot((call) => {
      const input = jsonBody<IntegrationOperationInputV1>(calls[0]);
      if (call.method === "POST")
        return response(pendingStatus(input, "awaiting_upload"));
      if (call.method === "PUT")
        return response(pendingStatus(input, "queued"));
      return response(
        completedStatus({
          ...input,
          media: { ...input.media, mediaSha256: "f".repeat(64) },
        }),
      );
    });
    const { runIntegratedImageAction } =
      await import("../../src/actions/integration-image.js");

    await expect(
      runIntegratedImageAction("check", selection, imageRetrieval()),
    ).rejects.toMatchObject({
      code: "integration_media_mismatch",
      retryable: false,
    });

    const { operationId } = jsonBody<IntegrationOperationInputV1>(calls[0]);
    expect(routes(calls)).toEqual([
      "POST /operations",
      `PUT /operations/${operationId}/media`,
      `GET /operations/${operationId}`,
    ]);
    expect(pendingIds(local)).toEqual([]);
    expect(await rawOutboxKeys()).toEqual([]);
  });

  it("keeps the outbox bytes and pending entry when DigiBot is unreachable", async () => {
    const local = await connect();
    const client = await import("../../src/integration-client.js");
    const calls = serveDigiBot((call) =>
      call.method === "POST"
        ? response(
            pendingStatus(
              jsonBody<IntegrationOperationInputV1>(call),
              "awaiting_upload",
            ),
          )
        : unreachable(),
    );
    const { runIntegratedImageAction } =
      await import("../../src/actions/integration-image.js");

    await expect(
      runIntegratedImageAction("download", selection, imageRetrieval()),
    ).rejects.toMatchObject({
      code: "integration_unavailable",
      retryable: true,
    });

    const { operationId } = jsonBody<IntegrationOperationInputV1>(calls[0]);
    expect(routes(calls)).toEqual([
      "POST /operations",
      `PUT /operations/${operationId}/media`,
    ]);
    expect(pendingIds(local)).toEqual([operationId]);
    const outbox = await client.getIntegrationOutbox(
      session.accountId,
      operationId,
    );
    expect(outbox?.bytes?.size).toBe(png.byteLength);
  });

  it("keeps the outbox bytes while DigiBot still awaits the upload", async () => {
    const local = await connect();
    const client = await import("../../src/integration-client.js");
    const calls = serveDigiBot((call) =>
      call.method === "GET"
        ? unreachable()
        : response(
            pendingStatus(
              jsonBody<IntegrationOperationInputV1>(calls[0]),
              "awaiting_upload",
            ),
          ),
    );
    const { runIntegratedImageAction } =
      await import("../../src/actions/integration-image.js");

    await expect(
      runIntegratedImageAction("download", selection, imageRetrieval()),
    ).rejects.toMatchObject({
      code: "integration_unavailable",
      retryable: true,
    });

    // The PUT answered awaiting_upload, so a later startup must still be able
    // to upload the exact bytes.
    const { operationId } = jsonBody<IntegrationOperationInputV1>(calls[0]);
    expect(routes(calls)).toEqual([
      "POST /operations",
      `PUT /operations/${operationId}/media`,
      `GET /operations/${operationId}`,
    ]);
    expect(pendingIds(local)).toEqual([operationId]);
    const outbox = await client.getIntegrationOutbox(
      session.accountId,
      operationId,
    );
    if (!outbox?.bytes)
      throw new Error("Expected the outbox to keep its bytes");
    expect([...new Uint8Array(await outbox.bytes.arrayBuffer())]).toEqual([
      ...png,
    ]);
  });

  it("removes the outbox and pending entry when DigiBot rejects the operation", async () => {
    const local = await connect();
    const calls = serveDigiBot(() => apiError(422, "media_rejected", false));
    const { runIntegratedImageAction } =
      await import("../../src/actions/integration-image.js");

    await expect(
      runIntegratedImageAction("download", selection, imageRetrieval()),
    ).rejects.toMatchObject({
      code: "media_rejected",
      retryable: false,
      status: 422,
    });

    expect(routes(calls)).toEqual(["POST /operations"]);
    expect(pendingIds(local)).toEqual([]);
    expect(await rawOutboxKeys()).toEqual([]);
  });

  it("rejects and cleans up when the connected account changes mid-operation", async () => {
    const local = await connect();
    const calls = serveDigiBot(async (call) => {
      await local.set({ [sessionKey]: otherSession });
      return response(
        pendingStatus(
          jsonBody<IntegrationOperationInputV1>(call),
          "awaiting_upload",
        ),
      );
    });
    const { runIntegratedImageAction } =
      await import("../../src/actions/integration-image.js");

    await expect(
      runIntegratedImageAction("download", selection, imageRetrieval()),
    ).rejects.toMatchObject({
      code: "integration_session_changed",
      retryable: false,
    });

    expect(routes(calls)).toEqual(["POST /operations"]);
    expect(pendingIds(local)).toEqual([]);
    expect(await rawOutboxKeys()).toEqual([]);
  });

  it("rejects and cleans up when the account changes before the final status returns", async () => {
    const local = await connect();
    const calls = serveDigiBot(async (call) => {
      const input = jsonBody<IntegrationOperationInputV1>(calls[0]);
      if (call.method === "POST")
        return response(pendingStatus(input, "awaiting_upload"));
      if (call.method === "PUT")
        return response(pendingStatus(input, "processing"));
      await local.set({ [sessionKey]: otherSession });
      return response(completedStatus(input));
    });
    const { runIntegratedImageAction } =
      await import("../../src/actions/integration-image.js");

    await expect(
      runIntegratedImageAction("download", selection, imageRetrieval()),
    ).rejects.toMatchObject({
      code: "integration_session_changed",
      retryable: false,
    });

    const { operationId } = jsonBody<IntegrationOperationInputV1>(calls[0]);
    expect(routes(calls)).toEqual([
      "POST /operations",
      `PUT /operations/${operationId}/media`,
      `GET /operations/${operationId}`,
    ]);
    expect(pendingIds(local)).toEqual([]);
    expect(await rawOutboxKeys()).toEqual([]);
  });

  it("stores nothing when the account changes while the image is read", async () => {
    const local = await connect();
    const calls = serveDigiBot(() => response({}));
    const { runIntegratedImageAction } =
      await import("../../src/actions/integration-image.js");

    await expect(
      runIntegratedImageAction(
        "check",
        selection,
        imageRetrieval(() => local.set({ [sessionKey]: otherSession })),
      ),
    ).rejects.toMatchObject({ code: "integration_session_changed" });

    expect(calls).toEqual([]);
    expect(pendingIds(local)).toEqual([]);
    expect(await rawOutboxKeys()).toEqual([]);
  });

  it("stops polling a Check once its verdict is saved while the archive is still pending", async () => {
    const local = await connect();
    const calls = serveDigiBot((call) => {
      const input = jsonBody<IntegrationOperationInputV1>(calls[0]);
      if (call.method === "POST")
        return response(pendingStatus(input, "awaiting_upload"));
      if (call.method === "PUT")
        return response(pendingStatus(input, "processing"));
      return response(processingWithVerdictStatus(input));
    });
    const { runIntegratedImageAction } =
      await import("../../src/actions/integration-image.js");

    const outcome = await runIntegratedImageAction(
      "check",
      selection,
      imageRetrieval(),
    );

    const { operationId } = jsonBody<IntegrationOperationInputV1>(calls[0]);
    expect(routes(calls)).toEqual([
      "POST /operations",
      `PUT /operations/${operationId}/media`,
      `GET /operations/${operationId}`,
    ]);
    expect(outcome.status.state).toBe("processing");
    expect(outcome.status.envelope?.result?.evidence.verdict).toBe(
      "no_supported_openai_signal",
    );
    expect(outcome.status.archive.deliveryState).toBe("pending");
    expect(pendingIds(local)).toEqual([]);
    expect(await rawOutboxKeys()).toEqual([]);
  });

  it("keeps polling a Download until it completes", async () => {
    const local = await connect();
    let polls = 0;
    const calls = serveDigiBot((call) => {
      const input = jsonBody<IntegrationOperationInputV1>(calls[0]);
      if (call.method === "POST")
        return response(pendingStatus(input, "awaiting_upload"));
      if (call.method === "PUT")
        return response(pendingStatus(input, "processing"));
      polls += 1;
      return response(
        polls === 1 ? archivingDownloadStatus(input) : completedStatus(input),
      );
    });
    const { runIntegratedImageAction } =
      await import("../../src/actions/integration-image.js");

    const outcome = await runIntegratedImageAction(
      "download",
      selection,
      imageRetrieval(),
    );

    const { operationId } = jsonBody<IntegrationOperationInputV1>(calls[0]);
    expect(routes(calls)).toEqual([
      "POST /operations",
      `PUT /operations/${operationId}/media`,
      `GET /operations/${operationId}`,
      `GET /operations/${operationId}`,
    ]);
    expect(outcome.status.state).toBe("completed");
    expect(outcome.status.envelope?.result).toBeNull();
    expect(pendingIds(local)).toEqual([]);
    expect(await rawOutboxKeys()).toEqual([]);
  });
});

describe("connected audio file action", () => {
  beforeEach(() => {
    resetIntegrationGlobals();
  });

  it("requires a connected session", async () => {
    installChrome();
    const calls = serveDigiBot(() => response({}));
    const { runIntegratedAudioFileAction } =
      await import("../../src/actions/integration-audio.js");

    await expect(runIntegratedAudioFileAction(audioFile())).rejects.toThrow(
      "Connect Provenance Lens to DigiBot before using connected audio checks.",
    );
    expect(calls).toEqual([]);
  });

  it("rejects an empty file before storing anything", async () => {
    const local = await connect();
    const calls = serveDigiBot(() => response({}));
    const { runIntegratedAudioFileAction } =
      await import("../../src/actions/integration-audio.js");

    await expect(
      runIntegratedAudioFileAction(
        new File([], "empty.wav", { type: "audio/wav" }),
      ),
    ).rejects.toThrow("Choose a non-empty audio file no larger than 4 MiB.");
    expect(calls).toEqual([]);
    expect(pendingIds(local)).toEqual([]);
    expect(await rawOutboxKeys()).toEqual([]);
  });

  it("hashes, stores, registers, uploads, and waits for the audio check", async () => {
    const local = await connect();
    const client = await import("../../src/integration-client.js");
    const file = audioFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const seen: Record<string, unknown> = {};
    const calls = serveDigiBot(async (call) => {
      const input = jsonBody<IntegrationOperationInputV1>(calls[0]);
      if (call.method === "POST") {
        seen["outboxAtCreate"] = await rawOutboxKeys();
        seen["pendingAtCreate"] = pendingIds(local);
        return response(pendingStatus(input, "awaiting_upload"));
      }
      if (call.method === "PUT")
        return response(pendingStatus(input, "processing"));
      const outbox = await client.getIntegrationOutbox(
        session.accountId,
        input.operationId,
      );
      seen["outboxBytesAtWait"] = outbox?.bytes;
      return response(completedStatus(input));
    });
    const { runIntegratedAudioFileAction } =
      await import("../../src/actions/integration-audio.js");

    const outcome = await runIntegratedAudioFileAction(file);

    const input = jsonBody<IntegrationOperationInputV1>(calls[0]);
    const { operationId } = input;
    expect(routes(calls)).toEqual([
      "POST /operations",
      `PUT /operations/${operationId}/media`,
      `GET /operations/${operationId}`,
    ]);
    expect(input).toMatchObject({
      action: "check",
      media: {
        mediaSha256: sha256(bytes),
        byteLength: bytes.byteLength,
        mimeType: "audio/wav",
        inputKind: "original",
        audioDurationSeconds: 1,
        segment: null,
      },
    });
    expect(seen["outboxAtCreate"]).toEqual([
      `${session.accountId}:${operationId}`,
    ]);
    expect(seen["pendingAtCreate"]).toEqual([operationId]);
    expect(await uploadedBytes(calls[1])).toEqual([...bytes]);
    expect(seen["outboxBytesAtWait"]).toBeNull();
    expect(outcome.status).toMatchObject({ operationId, state: "completed" });
    expect(outcome).toEqual({
      status: outcome.status,
      mediaSha256: sha256(bytes),
    });
    expect(pendingIds(local)).toEqual([]);
    expect(await rawOutboxKeys()).toEqual([]);
  });

  it("clears the pending entry and outbox once the verdict is saved while still processing", async () => {
    const local = await connect();
    const calls = serveDigiBot((call) => {
      const input = jsonBody<IntegrationOperationInputV1>(calls[0]);
      if (call.method === "POST")
        return response(pendingStatus(input, "awaiting_upload"));
      if (call.method === "PUT")
        return response(pendingStatus(input, "processing"));
      return response(processingWithVerdictStatus(input));
    });
    const { runIntegratedAudioFileAction } =
      await import("../../src/actions/integration-audio.js");

    const outcome = await runIntegratedAudioFileAction(audioFile());

    const { operationId } = jsonBody<IntegrationOperationInputV1>(calls[0]);
    expect(routes(calls)).toEqual([
      "POST /operations",
      `PUT /operations/${operationId}/media`,
      `GET /operations/${operationId}`,
    ]);
    expect(outcome.status.state).toBe("processing");
    expect(outcome.status.envelope?.result?.evidence.verdict).toBe(
      "no_supported_openai_signal",
    );
    expect(pendingIds(local)).toEqual([]);
    expect(await rawOutboxKeys()).toEqual([]);
  });

  it.each([
    {
      name: "keeps the outbox and pending entry after a retryable failure",
      failure: () => new Response("busy", { status: 503 }),
      error: { code: "integration_unavailable", retryable: true },
      kept: true,
    },
    {
      name: "removes the outbox and pending entry after a permanent failure",
      failure: () => apiError(413, "media_too_large", false),
      error: { code: "media_too_large", retryable: false },
      kept: false,
    },
  ])("$name", async ({ failure, error, kept }) => {
    const local = await connect();
    const calls = serveDigiBot((call) =>
      call.method === "POST"
        ? response(
            pendingStatus(
              jsonBody<IntegrationOperationInputV1>(call),
              "awaiting_upload",
            ),
          )
        : failure(),
    );
    const { runIntegratedAudioFileAction } =
      await import("../../src/actions/integration-audio.js");

    await expect(
      runIntegratedAudioFileAction(audioFile()),
    ).rejects.toMatchObject(error);

    const { operationId } = jsonBody<IntegrationOperationInputV1>(calls[0]);
    expect(routes(calls)).toEqual([
      "POST /operations",
      `PUT /operations/${operationId}/media`,
    ]);
    expect(pendingIds(local)).toEqual(kept ? [operationId] : []);
    expect(await rawOutboxKeys()).toEqual(
      kept ? [`${session.accountId}:${operationId}`] : [],
    );
  });

  it("keeps the outbox bytes while DigiBot still awaits the upload", async () => {
    const local = await connect();
    const client = await import("../../src/integration-client.js");
    const file = audioFile();
    const calls = serveDigiBot((call) =>
      call.method === "GET"
        ? unreachable()
        : response(
            pendingStatus(
              jsonBody<IntegrationOperationInputV1>(calls[0]),
              "awaiting_upload",
            ),
          ),
    );
    const { runIntegratedAudioFileAction } =
      await import("../../src/actions/integration-audio.js");

    await expect(runIntegratedAudioFileAction(file)).rejects.toMatchObject({
      code: "integration_unavailable",
      retryable: true,
    });

    const { operationId } = jsonBody<IntegrationOperationInputV1>(calls[0]);
    expect(routes(calls)).toEqual([
      "POST /operations",
      `PUT /operations/${operationId}/media`,
      `GET /operations/${operationId}`,
    ]);
    expect(pendingIds(local)).toEqual([operationId]);
    const outbox = await client.getIntegrationOutbox(
      session.accountId,
      operationId,
    );
    if (!outbox?.bytes)
      throw new Error("Expected the outbox to keep its bytes");
    expect([...new Uint8Array(await outbox.bytes.arrayBuffer())]).toEqual([
      ...new Uint8Array(await file.arrayBuffer()),
    ]);
  });

  it("rejects and cleans up an upload answered for different media", async () => {
    const local = await connect();
    const calls = serveDigiBot((call) => {
      const input = jsonBody<IntegrationOperationInputV1>(calls[0]);
      if (call.method === "POST")
        return response(pendingStatus(input, "awaiting_upload"));
      return response(
        completedStatus({
          ...input,
          media: { ...input.media, mediaSha256: "f".repeat(64) },
        }),
      );
    });
    const { runIntegratedAudioFileAction } =
      await import("../../src/actions/integration-audio.js");

    await expect(
      runIntegratedAudioFileAction(audioFile()),
    ).rejects.toMatchObject({
      code: "integration_media_mismatch",
      retryable: false,
    });

    const { operationId } = jsonBody<IntegrationOperationInputV1>(calls[0]);
    expect(routes(calls)).toEqual([
      "POST /operations",
      `PUT /operations/${operationId}/media`,
    ]);
    expect(pendingIds(local)).toEqual([]);
    expect(await rawOutboxKeys()).toEqual([]);
  });

  it("rejects and cleans up a verdict for different media that arrives after the wait", async () => {
    const local = await connect();
    const calls = serveDigiBot((call) => {
      const input = jsonBody<IntegrationOperationInputV1>(calls[0]);
      if (call.method === "POST")
        return response(pendingStatus(input, "awaiting_upload"));
      if (call.method === "PUT")
        return response(pendingStatus(input, "queued"));
      return response(
        completedStatus({
          ...input,
          media: { ...input.media, mediaSha256: "f".repeat(64) },
        }),
      );
    });
    const { runIntegratedAudioFileAction } =
      await import("../../src/actions/integration-audio.js");

    await expect(
      runIntegratedAudioFileAction(audioFile()),
    ).rejects.toMatchObject({
      code: "integration_media_mismatch",
      retryable: false,
    });

    const { operationId } = jsonBody<IntegrationOperationInputV1>(calls[0]);
    expect(routes(calls)).toEqual([
      "POST /operations",
      `PUT /operations/${operationId}/media`,
      `GET /operations/${operationId}`,
    ]);
    expect(pendingIds(local)).toEqual([]);
    expect(await rawOutboxKeys()).toEqual([]);
  });

  it("rejects and cleans up when the connected account changes during upload", async () => {
    const local = await connect();
    const calls = serveDigiBot(async (call) => {
      const input = jsonBody<IntegrationOperationInputV1>(calls[0]);
      if (call.method === "PUT")
        await local.set({ [sessionKey]: otherSession });
      return response(pendingStatus(input, "awaiting_upload"));
    });
    const { runIntegratedAudioFileAction } =
      await import("../../src/actions/integration-audio.js");

    await expect(
      runIntegratedAudioFileAction(audioFile()),
    ).rejects.toMatchObject({
      code: "integration_session_changed",
      retryable: false,
    });

    expect(calls.map(({ method }) => method)).toEqual(["POST", "PUT"]);
    expect(pendingIds(local)).toEqual([]);
    expect(await rawOutboxKeys()).toEqual([]);
  });
});

describe("connected audio segment action", () => {
  const sourceUrl = "https://video.example/watch?id=fixture";
  const derivedSha256 = "b".repeat(64);

  function derivedInput(operationId: string): IntegrationOperationInputV1 {
    return {
      version: 1,
      operationId,
      action: "check",
      media: {
        mediaSha256: derivedSha256,
        byteLength: 4_096,
        mimeType: "audio/mpeg",
        inputKind: "derived_audio_segment",
        audioDurationSeconds: 30,
        segment: { startSeconds: 30, endSeconds: 60 },
        fullSourceSha256: null,
      },
      forceRecheck: false,
    };
  }

  function queuedSegment(operationId: string) {
    return {
      ...pendingStatus(derivedInput(operationId), "queued"),
      mediaSha256: null,
    };
  }

  beforeEach(() => {
    resetIntegrationGlobals();
  });

  it("requires a connected session", async () => {
    installChrome();
    const calls = serveDigiBot(() => response({}));
    const { runIntegratedAudioSegmentAction } =
      await import("../../src/actions/integration-audio.js");

    await expect(
      runIntegratedAudioSegmentAction(sourceUrl, 30, 60),
    ).rejects.toThrow(
      "Connect Provenance Lens to DigiBot before using connected audio checks.",
    );
    expect(calls).toEqual([]);
  });

  it.each([
    "https://user:secret@video.example/watch?id=fixture",
    "ftp://video.example/clip.mp4",
  ])("rejects %s before storing anything", async (url) => {
    const local = await connect();
    const calls = serveDigiBot(() => response({}));
    const { runIntegratedAudioSegmentAction } =
      await import("../../src/actions/integration-audio.js");

    await expect(runIntegratedAudioSegmentAction(url, 30, 60)).rejects.toThrow(
      "Enter a valid HTTP(S) video URL without credentials.",
    );
    expect(calls).toEqual([]);
    expect(pendingIds(local)).toEqual([]);
    expect(await rawOutboxKeys()).toEqual([]);
  });

  it("stores the request, registers it, drops the request copy, and waits", async () => {
    const local = await connect();
    const seen: Record<string, unknown> = {};
    const calls = serveDigiBot(async (call) => {
      const { operationId } = jsonBody<{ operationId: string }>(calls[0]);
      if (call.method === "POST") {
        seen["outboxAtCreate"] = await rawOutboxKeys();
        seen["pendingAtCreate"] = pendingIds(local);
        return response(queuedSegment(operationId));
      }
      seen["outboxAtWait"] = await rawOutboxKeys();
      return response(completedStatus(derivedInput(operationId)));
    });
    const { runIntegratedAudioSegmentAction } =
      await import("../../src/actions/integration-audio.js");

    const outcome = await runIntegratedAudioSegmentAction(sourceUrl, 30, 60);

    const body = jsonBody<{ operationId: string }>(calls[0]);
    const { operationId } = body;
    expect(routes(calls)).toEqual([
      "POST /audio-segments",
      `GET /operations/${operationId}`,
    ]);
    expect(body).toEqual({
      operationId,
      sourceUrl,
      startSeconds: 30,
      endSeconds: 60,
    });
    expect(seen["outboxAtCreate"]).toEqual([
      `${session.accountId}:segment:${operationId}`,
    ]);
    expect(seen["pendingAtCreate"]).toEqual([operationId]);
    expect(seen["outboxAtWait"]).toEqual([]);
    expect(outcome.status).toMatchObject({ operationId, state: "completed" });
    expect(outcome).toEqual({
      status: outcome.status,
      mediaSha256: derivedSha256,
    });
    expect(pendingIds(local)).toEqual([]);
  });

  it("clears the pending entry once the segment verdict is saved while still processing", async () => {
    const local = await connect();
    const calls = serveDigiBot((call) => {
      const { operationId } = jsonBody<{ operationId: string }>(calls[0]);
      if (call.method === "POST") return response(queuedSegment(operationId));
      return response(processingWithVerdictStatus(derivedInput(operationId)));
    });
    const { runIntegratedAudioSegmentAction } =
      await import("../../src/actions/integration-audio.js");

    const outcome = await runIntegratedAudioSegmentAction(sourceUrl, 30, 60);

    const { operationId } = jsonBody<{ operationId: string }>(calls[0]);
    expect(routes(calls)).toEqual([
      "POST /audio-segments",
      `GET /operations/${operationId}`,
    ]);
    expect(outcome.status.state).toBe("processing");
    expect(outcome.status.envelope?.result).not.toBeNull();
    expect(pendingIds(local)).toEqual([]);
    expect(await rawOutboxKeys()).toEqual([]);
  });

  it.each([
    {
      name: "keeps the request copy and pending entry when DigiBot is unreachable",
      failure: unreachable,
      error: { code: "integration_unavailable", retryable: true },
      kept: true,
    },
    {
      name: "removes the request copy and pending entry when DigiBot refuses it",
      failure: () => apiError(400, "unsupported_source", false),
      error: { code: "unsupported_source", retryable: false },
      kept: false,
    },
  ])("$name", async ({ failure, error, kept }) => {
    const local = await connect();
    const calls = serveDigiBot(failure);
    const { runIntegratedAudioSegmentAction } =
      await import("../../src/actions/integration-audio.js");

    await expect(
      runIntegratedAudioSegmentAction(sourceUrl, 30, 60),
    ).rejects.toMatchObject(error);

    const { operationId } = jsonBody<{ operationId: string }>(calls[0]);
    expect(routes(calls)).toEqual(["POST /audio-segments"]);
    expect(pendingIds(local)).toEqual(kept ? [operationId] : []);
    expect(await rawOutboxKeys()).toEqual(
      kept ? [`${session.accountId}:segment:${operationId}`] : [],
    );
  });

  it("rejects and cleans up when the connected account changes", async () => {
    const local = await connect();
    const calls = serveDigiBot(async () => {
      const { operationId } = jsonBody<{ operationId: string }>(calls[0]);
      await local.set({ [sessionKey]: otherSession });
      return response(queuedSegment(operationId));
    });
    const { runIntegratedAudioSegmentAction } =
      await import("../../src/actions/integration-audio.js");

    await expect(
      runIntegratedAudioSegmentAction(sourceUrl, 30, 60),
    ).rejects.toMatchObject({
      code: "integration_session_changed",
      retryable: false,
    });

    expect(routes(calls)).toEqual(["POST /audio-segments"]);
    expect(pendingIds(local)).toEqual([]);
    expect(await rawOutboxKeys()).toEqual([]);
  });
});

describe("connected page link action", () => {
  const pageUrl = "https://video.example/watch?v=fixture";
  const jobId = "44444444-4444-4444-8444-444444444444";
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

  function queuedJob(): Response {
    return response({ jobId, state: "queued" }, 202);
  }

  function workflow(local: MemoryArea) {
    return local.values[STORAGE_KEYS.workflow] as
      { status: string; actionId: string | null; message: string } | undefined;
  }

  beforeEach(() => {
    resetIntegrationGlobals();
  });

  it("requires a connected session before sending anything", async () => {
    const { local } = installChrome();
    const calls = serveDigiBot(() => queuedJob());
    const { sendPageLink } =
      await import("../../src/actions/integration-link.js");

    await expect(sendPageLink({ url: pageUrl })).rejects.toThrow(
      "Connect Provenance Lens to DigiBot before sending a page link.",
    );
    expect(calls).toEqual([]);
    expect(workflow(local)).toMatchObject({
      status: "error",
      actionId: LINK_ACTION_ID,
      message: "Connect Provenance Lens to DigiBot before sending a page link.",
    });
  });

  it("posts exactly the page link once and stores nothing locally", async () => {
    const local = await connect();
    const seen: Record<string, unknown> = {};
    const calls = serveDigiBot(() => {
      seen["workflowAtPost"] = workflow(local);
      return queuedJob();
    });
    const {
      PAGE_LINK_QUEUED_MESSAGE,
      PAGE_LINK_SENDING_MESSAGE,
      sendPageLink,
    } = await import("../../src/actions/integration-link.js");

    await expect(sendPageLink({ url: pageUrl })).resolves.toBeUndefined();

    expect(routes(calls)).toEqual(["POST /link-downloads"]);
    const body = jsonBody<Record<string, unknown>>(calls[0]);
    expect(Object.keys(body).sort()).toEqual(["operationId", "sourceUrl"]);
    expect(String(body["operationId"])).toMatch(uuidPattern);
    expect(body["sourceUrl"]).toBe(pageUrl);
    expect(calls[0]?.headers.get("Authorization")).toBe(
      `Bearer ${session.accessToken}`,
    );
    expect(calls[0]?.headers.get("Content-Type")).toBe("application/json");
    // The request carries a timeout so a service worker never hangs on it.
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.signal?.aborted).toBe(false);
    expect(seen["workflowAtPost"]).toMatchObject({
      status: "sending",
      actionId: LINK_ACTION_ID,
      message: PAGE_LINK_SENDING_MESSAGE,
    });
    expect(workflow(local)).toMatchObject({
      status: "idle",
      actionId: null,
      message: PAGE_LINK_QUEUED_MESSAGE,
    });
    expect(pendingIds(local)).toEqual([]);
    expect(await rawOutboxKeys()).toEqual([]);
  });

  it("sends the MP3 output and the clip range only when asked", async () => {
    await connect();
    const calls = serveDigiBot(() => queuedJob());
    const { sendPageLink } =
      await import("../../src/actions/integration-link.js");
    const clip = { startSeconds: 65, endSeconds: 120 };

    await sendPageLink({ url: pageUrl }, { output: "mp3" });
    await sendPageLink({ url: pageUrl }, clip);
    await sendPageLink({ url: pageUrl }, { output: "mp3", ...clip });

    expect(routes(calls)).toEqual(
      Array<string>(3).fill("POST /link-downloads"),
    );
    const bodies = calls.map((call) => jsonBody<Record<string, unknown>>(call));
    expect(bodies).toMatchObject([
      { sourceUrl: pageUrl, output: "mp3" },
      { sourceUrl: pageUrl, ...clip },
      { sourceUrl: pageUrl, output: "mp3", ...clip },
    ]);
    expect(bodies.map((body) => Object.keys(body).sort())).toEqual([
      ["operationId", "output", "sourceUrl"],
      ["endSeconds", "operationId", "sourceUrl", "startSeconds"],
      ["endSeconds", "operationId", "output", "sourceUrl", "startSeconds"],
    ]);
  });

  it("refuses a one-sided or inverted clip before any request", async () => {
    const local = await connect();
    const calls = serveDigiBot(() => queuedJob());
    const { PAGE_LINK_OPTIONS_MESSAGE, sendPageLink } =
      await import("../../src/actions/integration-link.js");

    for (const options of [
      { startSeconds: 65 },
      { startSeconds: 120, endSeconds: 65 },
    ]) {
      await expect(sendPageLink({ url: pageUrl }, options)).rejects.toThrow(
        PAGE_LINK_OPTIONS_MESSAGE,
      );
    }
    expect(calls).toEqual([]);
    expect(workflow(local)).toMatchObject({
      status: "error",
      actionId: LINK_ACTION_ID,
      message: PAGE_LINK_OPTIONS_MESSAGE,
    });
  });

  it("drops the fragment before sending the page link", async () => {
    await connect();
    const calls = serveDigiBot(() => queuedJob());
    const { sendPageLink } =
      await import("../../src/actions/integration-link.js");

    await sendPageLink({ url: `${pageUrl}#access_token=secret` });

    expect(routes(calls)).toEqual(["POST /link-downloads"]);
    expect(jsonBody<Record<string, unknown>>(calls[0])["sourceUrl"]).toBe(
      pageUrl,
    );
  });

  it.each([
    "chrome://extensions",
    "file:///videos/clip.mp4",
    "https://user:secret@video.example/watch?v=fixture",
    undefined,
  ])("refuses the page %s before any request", async (url) => {
    const local = await connect();
    const calls = serveDigiBot(() => queuedJob());
    const { sendPageLink } =
      await import("../../src/actions/integration-link.js");

    await expect(sendPageLink({ url })).rejects.toThrow(
      "Only an HTTP or HTTPS page address can be sent to Telegram.",
    );
    expect(calls).toEqual([]);
    expect(workflow(local)).toMatchObject({
      status: "error",
      actionId: LINK_ACTION_ID,
      message: "Only an HTTP or HTTPS page address can be sent to Telegram.",
    });
  });

  it("shows DigiBot's job limit message verbatim", async () => {
    const local = await connect();
    const message = "Your hourly request limit is reached. Try again later.";
    const calls = serveDigiBot(() =>
      response({ error: { code: "job_limit", message, retryable: true } }, 429),
    );
    const { sendPageLink } =
      await import("../../src/actions/integration-link.js");

    await expect(sendPageLink({ url: pageUrl })).rejects.toMatchObject({
      code: "job_limit",
      status: 429,
      retryable: true,
      message,
    });
    expect(routes(calls)).toEqual(["POST /link-downloads"]);
    expect(workflow(local)).toMatchObject({
      status: "error",
      actionId: LINK_ACTION_ID,
      message,
    });
    expect(await rawOutboxKeys()).toEqual([]);
  });

  it("reports a malformed acceptance without inventing a job", async () => {
    const local = await connect();
    serveDigiBot(() => response({ jobId: "job-1", state: "queued" }, 202));
    const { sendPageLink } =
      await import("../../src/actions/integration-link.js");

    await expect(sendPageLink({ url: pageUrl })).rejects.toThrow();
    expect(workflow(local)).toMatchObject({
      status: "error",
      actionId: LINK_ACTION_ID,
      message: "The page link could not be sent to DigiBot.",
    });
  });
});
