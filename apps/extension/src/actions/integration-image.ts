import {
  IntegrationOperationInputV1Schema,
  type IntegrationOperationStatus,
  type ImageSelection,
} from "@provenance-lens/shared";

import {
  addPendingIntegrationOperation,
  assertIntegrationMediaDigest,
  createIntegrationOperation,
  getIntegrationSession,
  IntegrationClientError,
  hashIntegrationMedia,
  isIntegrationOperationSettled,
  markIntegrationOutboxUploaded,
  removeIntegrationOutbox,
  removePendingIntegrationOperation,
  saveIntegrationOutbox,
  uploadIntegrationMedia,
  waitForIntegrationOperation,
  type IntegrationOutboxEntry,
} from "../integration-client.js";
import {
  retrieveSelectedImage,
  type ImageRetrievalContext,
} from "./verify-openai-provenance.js";

export type IntegratedImageAction = "check" | "download";

export type IntegratedImageOutcome = {
  status: IntegrationOperationStatus;
  imageSha256: string;
  selection: Pick<ImageSelection, "sourceHostname" | "pageTitle">;
};

export async function runIntegratedImageAction(
  action: IntegratedImageAction,
  selection: ImageSelection,
  retrieval: ImageRetrievalContext,
): Promise<IntegratedImageOutcome> {
  const session = await getIntegrationSession();
  if (!session)
    throw new Error(
      "Connect Provenance Lens to DigiBot before using connected actions.",
    );
  const expectedSession = {
    accountId: session.accountId,
    sessionId: session.sessionId,
  };

  const image = await retrieveSelectedImage(selection, retrieval);
  let operationId: string | null = null;
  let outboxSaved = false;
  try {
    const imageSha256 = await hashIntegrationMedia(image.bytes);
    operationId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const input = IntegrationOperationInputV1Schema.parse({
      version: 1,
      operationId,
      action,
      media: {
        mediaSha256: imageSha256,
        byteLength: image.bytes.byteLength,
        mimeType: image.mime,
        inputKind: "original",
        audioDurationSeconds: null,
        segment: null,
        fullSourceSha256: null,
      },
      forceRecheck: false,
    });
    const outbox: Omit<IntegrationOutboxEntry, "bytes" | "sessionId"> & {
      sessionId: string;
      bytes: Uint8Array;
    } = {
      accountId: session.accountId,
      sessionId: session.sessionId,
      operationId,
      createdAt,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
      input,
      bytes: image.bytes,
    };
    await saveIntegrationOutbox(outbox);
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
        image.bytes,
        image.mime,
        expectedSession,
      );
    }
    // As in the resume path, the outbox keeps the bytes until DigiBot no
    // longer awaits them, so a later startup can still upload them.
    if (status.state !== "awaiting_upload")
      await markIntegrationOutboxUploaded(session.accountId, operationId);
    if (!isIntegrationOperationSettled(status)) {
      status = await waitForIntegrationOperation(
        operationId,
        undefined,
        expectedSession,
      );
    }
    assertIntegrationMediaDigest(status, imageSha256);
    // A saved Check verdict is final even while DigiBot still archives the
    // original to Telegram: the bytes left the outbox when the upload was
    // marked, and History reports the archive, so nothing local remains.
    if (isIntegrationOperationSettled(status)) {
      await removePendingIntegrationOperation(session.accountId, operationId);
      await removeIntegrationOutbox(session.accountId, operationId);
      outboxSaved = false;
    }
    return {
      status,
      imageSha256,
      selection: {
        sourceHostname: selection.sourceHostname,
        pageTitle: selection.pageTitle,
      },
    };
  } catch (error: unknown) {
    if (
      error instanceof IntegrationClientError &&
      !error.retryable &&
      operationId !== null
    ) {
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
    image.bytes.fill(0);
    // Keep the durable outbox for a failed/unknown network operation. It is
    // the only place where bytes survive a service-worker restart.
    if (!outboxSaved && operationId !== null) {
      await removeIntegrationOutbox(session.accountId, operationId).catch(
        () => undefined,
      );
    }
  }
}
