import {
  IntegrationOperationInputV1Schema,
  IntegrationSegmentSchema,
  MAX_AUDIO_BYTES,
  sha256Hex,
  validateAudioBlob,
  type IntegrationOperationStatus,
} from "@provenance-lens/shared";

import {
  addPendingIntegrationOperation,
  createAudioSegmentOperation,
  createIntegrationOperation,
  IntegrationClientError,
  getIntegrationSession,
  markIntegrationOutboxUploaded,
  removeIntegrationOutbox,
  removeIntegrationSegmentOutbox,
  removePendingIntegrationOperation,
  saveIntegrationOutbox,
  saveIntegrationSegmentOutbox,
  uploadIntegrationMedia,
  waitForIntegrationOperation,
} from "../integration-client.js";

export type IntegratedAudioOutcome = {
  status: IntegrationOperationStatus;
  mediaSha256: string | null;
};

export async function runIntegratedAudioFileAction(
  file: File,
): Promise<IntegratedAudioOutcome> {
  const session = requireSession(await getIntegrationSession());
  const expectedSession = {
    accountId: session.accountId,
    sessionId: session.sessionId,
  };
  if (file.size <= 0 || file.size > MAX_AUDIO_BYTES)
    throw new Error("Choose a non-empty audio file no larger than 4 MiB.");
  const validation = await validateAudioBlob(file, file.type);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mediaSha256 = await sha256Hex(bytes);
  const operationId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const input = IntegrationOperationInputV1Schema.parse({
    version: 1,
    operationId,
    action: "check",
    media: {
      mediaSha256,
      byteLength: bytes.byteLength,
      mimeType: validation.mime,
      inputKind: "original",
      audioDurationSeconds: validation.durationSeconds,
      segment: null,
      fullSourceSha256: null,
    },
    forceRecheck: false,
  });
  let outboxSaved = false;
  try {
    await saveIntegrationOutbox({
      accountId: session.accountId,
      sessionId: session.sessionId,
      operationId,
      createdAt,
      expiresAt: expiresAt(),
      input,
      bytes,
    });
    outboxSaved = true;
    await addPendingIntegrationOperation({
      accountId: session.accountId,
      sessionId: session.sessionId,
      operationId,
      createdAt,
    });
    let status = await createIntegrationOperation(
      input,
      createdAt,
      expectedSession,
    );
    if (status.state === "awaiting_upload") {
      status = await uploadIntegrationMedia(
        operationId,
        bytes,
        validation.mime,
        expectedSession,
      );
    }
    await markIntegrationOutboxUploaded(session.accountId, operationId);
    if (status.state !== "completed" && status.state !== "failed")
      status = await waitForIntegrationOperation(
        operationId,
        undefined,
        expectedSession,
      );
    if (status.state === "completed" || status.state === "failed") {
      await removePendingIntegrationOperation(session.accountId, operationId);
      await removeIntegrationOutbox(session.accountId, operationId);
      outboxSaved = false;
    }
    return { status, mediaSha256 };
  } catch (error: unknown) {
    if (error instanceof IntegrationClientError && !error.retryable) {
      await removePendingIntegrationOperation(
        session.accountId,
        operationId,
      ).catch(() => undefined);
      await removeIntegrationOutbox(session.accountId, operationId).catch(
        () => undefined,
      );
      outboxSaved = false;
    }
    throw error;
  } finally {
    bytes.fill(0);
    if (!outboxSaved)
      await removeIntegrationOutbox(session.accountId, operationId).catch(
        () => undefined,
      );
  }
}

export async function runIntegratedAudioSegmentAction(
  sourceUrl: string,
  startSeconds: number,
  endSeconds: number,
): Promise<IntegratedAudioOutcome> {
  const session = requireSession(await getIntegrationSession());
  const expectedSession = {
    accountId: session.accountId,
    sessionId: session.sessionId,
  };
  const source = parseVideoSourceUrl(sourceUrl);
  const segment = IntegrationSegmentSchema.parse({
    startSeconds,
    endSeconds,
  });
  const operationId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await saveIntegrationSegmentOutbox({
    accountId: session.accountId,
    sessionId: session.sessionId,
    operationId,
    createdAt,
    expiresAt: expiresAt(),
    sourceUrl: source.toString(),
    startSeconds: segment.startSeconds,
    endSeconds: segment.endSeconds,
  });
  await addPendingIntegrationOperation({
    accountId: session.accountId,
    sessionId: session.sessionId,
    operationId,
    createdAt,
  });
  try {
    let status = await createAudioSegmentOperation(
      operationId,
      source.toString(),
      segment.startSeconds,
      segment.endSeconds,
      createdAt,
      expectedSession,
    );
    await removeIntegrationSegmentOutbox(session.accountId, operationId);
    if (status.state !== "completed" && status.state !== "failed")
      status = await waitForIntegrationOperation(
        operationId,
        undefined,
        expectedSession,
      );
    if (status.state === "completed" || status.state === "failed")
      await removePendingIntegrationOperation(session.accountId, operationId);
    return {
      status,
      mediaSha256: status.mediaSha256,
    };
  } catch (error: unknown) {
    if (error instanceof IntegrationClientError && !error.retryable) {
      await removePendingIntegrationOperation(
        session.accountId,
        operationId,
      ).catch(() => undefined);
      await removeIntegrationSegmentOutbox(
        session.accountId,
        operationId,
      ).catch(() => undefined);
    }
    throw error;
  }
}

function requireSession(
  session: Awaited<ReturnType<typeof getIntegrationSession>>,
) {
  if (!session)
    throw new Error(
      "Connect Provenance Lens to DigiBot before using connected audio checks.",
    );
  return session;
}

function expiresAt(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
}

function parseVideoSourceUrl(value: string): URL {
  let source: URL;
  try {
    source = new URL(value.trim());
  } catch {
    throw new Error("Enter a valid HTTP(S) video URL.");
  }
  if (
    !["http:", "https:"].includes(source.protocol) ||
    source.username ||
    source.password
  )
    throw new Error("Enter a valid HTTP(S) video URL without credentials.");
  return source;
}
