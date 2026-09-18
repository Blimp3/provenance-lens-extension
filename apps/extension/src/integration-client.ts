import {
  IntegrationApiErrorSchema,
  IntegrationDeleteResponseSchema,
  IntegrationHistoryResponseSchema,
  IntegrationOperationInputV1Schema,
  IntegrationOperationStatusSchema,
  IntegrationPairingExchangeRequestSchema,
  IntegrationPairingRequestSchema,
  IntegrationPairingResponseSchema,
  IntegrationRefreshRequestSchema,
  IntegrationSessionResponseSchema,
  IntegrationStatsSchema,
  MAX_INTEGRATION_CHECK_BYTES,
  INTEGRATION_DOWNLOAD_MAX_BYTES,
  sha256Hex,
  type IntegrationHistoryResponse,
  type IntegrationOperationInputV1,
  type IntegrationOperationStatus,
  type IntegrationPairingResponse,
  type IntegrationPeriod,
  type IntegrationSessionResponse,
  type IntegrationStats,
  type Sha256,
  type SupportedMediaMime,
} from "@provenance-lens/shared";

export const INTEGRATION_API_BASE_URL =
  "https://private-media-downloader.yellow-salad-bfde.workers.dev/api/integration";

const STORAGE_KEYS = {
  session: "provenanceLens.integration.session",
  pendingPairing: "provenanceLens.integration.pendingPairing",
  pendingOperations: "provenanceLens.integration.pendingOperations",
} as const;

const OUTBOX_DATABASE = "provenance-lens-integration-outbox";
const OUTBOX_VERSION = 1;
const OUTBOX_STORE = "operations";
const SEGMENT_OUTBOX_PREFIX = "segment:";
const OPERATION_POLL_MS = 1_000;
const OPERATION_POLL_TIMEOUT_MS = 60_000;
const EXPIRY_SKEW_MS = 15_000;
const MAX_HISTORY_PAGES = 50;
const SESSION_LOCK = "provenance-lens-integration-session";
const MAX_OUTBOX_ENTRIES = 20;
const MAX_OUTBOX_TOTAL_BYTES =
  INTEGRATION_DOWNLOAD_MAX_BYTES + MAX_INTEGRATION_CHECK_BYTES;

type PendingPairing = IntegrationPairingResponse & {
  verifier: string;
  deviceName: string;
};

export type IntegrationSession = IntegrationSessionResponse;

export type IntegrationPendingOperation = {
  accountId: string;
  sessionId: string;
  operationId: string;
  createdAt: string;
};

export type IntegrationOutboxEntry = {
  accountId: string;
  sessionId: string;
  operationId: string;
  createdAt: string;
  expiresAt: string;
  input: IntegrationOperationInputV1;
  bytes: Blob | null;
};

export type IntegrationSegmentOutboxEntry = {
  accountId: string;
  sessionId: string;
  operationId: string;
  createdAt: string;
  expiresAt: string;
  sourceUrl: string;
  startSeconds: number;
  endSeconds: number;
};

export class IntegrationClientError extends Error {
  public constructor(
    message: string,
    public readonly code = "integration_unavailable",
    public readonly retryable = true,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = "IntegrationClientError";
  }
}

export type IntegrationSessionExpectation = Pick<
  IntegrationSession,
  "accountId" | "sessionId"
>;

export async function getIntegrationSession(): Promise<IntegrationSession | null> {
  // Older test harnesses and non-extension callers may not provide the
  // optional storage surface; that means there is no connected account.
  const storage = chrome.storage?.local;
  if (!storage || typeof storage.get !== "function") return null;
  const values = await storage.get(STORAGE_KEYS.session);
  const parsed = IntegrationSessionResponseSchema.safeParse(
    values[STORAGE_KEYS.session],
  );
  return parsed.success ? parsed.data : null;
}

export async function isIntegrationConnected(): Promise<boolean> {
  return (await getIntegrationSession()) !== null;
}

export async function createPairing(
  deviceName = "Provenance Lens browser",
): Promise<IntegrationPairingResponse> {
  const verifier = createVerifier();
  const request = IntegrationPairingRequestSchema.parse({
    verifier,
    deviceName,
  });
  const response = await requestUnauthenticated("/pairings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  const pairing = await parseResponse(
    response,
    IntegrationPairingResponseSchema,
  );
  await chrome.storage.session.set({
    [STORAGE_KEYS.pendingPairing]: { ...pairing, verifier, deviceName },
  });
  return pairing;
}

export async function getPendingPairing(): Promise<PendingPairing | null> {
  const values = await chrome.storage.session.get(STORAGE_KEYS.pendingPairing);
  const value = values[STORAGE_KEYS.pendingPairing];
  if (!isPendingPairing(value)) return null;
  if (Date.parse(value.expiresAt) <= Date.now()) {
    await chrome.storage.session.remove(STORAGE_KEYS.pendingPairing);
    return null;
  }
  return value;
}

export async function exchangePairing(): Promise<IntegrationSession> {
  const pending = await getPendingPairing();
  if (!pending)
    throw new IntegrationClientError(
      "The pairing request has expired. Start pairing again.",
      "pairing_expired",
      false,
    );
  const body = IntegrationPairingExchangeRequestSchema.parse({
    verifier: pending.verifier,
  });
  const response = await requestUnauthenticated(
    `/pairings/${encodeURIComponent(pending.pairId)}/exchange`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const session = await parseResponse(
    response,
    IntegrationSessionResponseSchema,
  );
  await replaceIntegrationSession(session);
  return session;
}

export async function disconnectIntegration(): Promise<void> {
  const session = await getIntegrationSession();
  if (session) {
    try {
      await authenticatedRequest(
        `/sessions/${encodeURIComponent(session.sessionId)}`,
        {
          method: "DELETE",
        },
        true,
        sessionExpectation(session),
      );
    } catch {
      // Local revocation is still required when the server is unavailable.
    }
  }
  if (session) await clearIntegrationSessionIfCurrent(session);
  else await clearIntegrationSession();
}

export async function clearIntegrationSession(): Promise<void> {
  await withSessionLock(clearIntegrationStateUnlocked);
}

export async function createIntegrationOperation(
  input: IntegrationOperationInputV1,
  createdAt: string,
  expectedSession?: IntegrationSessionExpectation,
): Promise<IntegrationOperationStatus> {
  const parsed = IntegrationOperationInputV1Schema.parse(input);
  const expected =
    expectedSession ?? (await operationSessionExpectation(parsed.operationId));
  const response = await authenticatedRequest(
    "/operations",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Integration-Created-At": createdAt,
      },
      body: JSON.stringify(parsed),
    },
    true,
    expected,
  );
  return parseResponse(response, IntegrationOperationStatusSchema);
}

export async function createAudioSegmentOperation(
  operationId: string,
  sourceUrl: string,
  startSeconds: number,
  endSeconds: number,
  createdAt: string,
  expectedSession?: IntegrationSessionExpectation,
): Promise<IntegrationOperationStatus> {
  const expected =
    expectedSession ?? (await operationSessionExpectation(operationId));
  const response = await authenticatedRequest(
    "/audio-segments",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Integration-Created-At": createdAt,
      },
      body: JSON.stringify({
        operationId,
        sourceUrl,
        startSeconds,
        endSeconds,
      }),
    },
    true,
    expected,
  );
  return parseResponse(response, IntegrationOperationStatusSchema);
}

export async function uploadIntegrationMedia(
  operationId: string,
  bytes: Uint8Array,
  mimeType: SupportedMediaMime,
  expectedSession?: IntegrationSessionExpectation,
): Promise<IntegrationOperationStatus> {
  const expected =
    expectedSession ?? (await operationSessionExpectation(operationId));
  const response = await authenticatedRequest(
    `/operations/${encodeURIComponent(operationId)}/media`,
    {
      method: "PUT",
      headers: { "Content-Type": mimeType },
      body: new Blob([toArrayBuffer(bytes)], { type: mimeType }),
    },
    true,
    expected,
  );
  return parseResponse(response, IntegrationOperationStatusSchema);
}

export async function getIntegrationOperation(
  operationId: string,
): Promise<IntegrationOperationStatus> {
  return getIntegrationOperationForSession(
    operationId,
    await operationSessionExpectation(operationId),
  );
}

async function getIntegrationOperationForSession(
  operationId: string,
  expected: IntegrationSessionExpectation,
): Promise<IntegrationOperationStatus> {
  const response = await authenticatedRequest(
    `/operations/${encodeURIComponent(operationId)}`,
    { method: "GET" },
    true,
    expected,
  );
  return parseResponse(response, IntegrationOperationStatusSchema);
}

export async function waitForIntegrationOperation(
  operationId: string,
  signal?: AbortSignal,
  expectedSession?: IntegrationSessionExpectation,
): Promise<IntegrationOperationStatus> {
  const expected =
    expectedSession ?? (await operationSessionExpectation(operationId));
  const deadline = Date.now() + OPERATION_POLL_TIMEOUT_MS;
  let latest = await getIntegrationOperationForSession(operationId, expected);
  while (
    latest.state !== "completed" &&
    latest.state !== "failed" &&
    Date.now() < deadline
  ) {
    await delay(OPERATION_POLL_MS, signal);
    latest = await getIntegrationOperationForSession(operationId, expected);
  }
  return latest;
}

export async function retryIntegrationOperation(
  operationId: string,
): Promise<IntegrationOperationStatus> {
  const expected = await operationSessionExpectation(operationId);
  const response = await authenticatedRequest(
    `/operations/${encodeURIComponent(operationId)}/retry`,
    { method: "POST" },
    true,
    expected,
  );
  return parseResponse(response, IntegrationOperationStatusSchema);
}

export async function getIntegrationHistory(
  period: IntegrationPeriod,
  cursor?: string,
): Promise<IntegrationHistoryResponse> {
  const query = new URLSearchParams({ period });
  if (cursor) query.set("cursor", cursor);
  const response = await authenticatedRequest(`/history?${query.toString()}`, {
    method: "GET",
  });
  return parseResponse(response, IntegrationHistoryResponseSchema);
}

export async function getAllIntegrationHistory(
  period: IntegrationPeriod,
): Promise<{
  operations: IntegrationOperationStatus[];
  nextCursor: string | null;
}> {
  const operations: IntegrationOperationStatus[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let nextCursor: string | null = null;
  for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
    const response = await getIntegrationHistory(period, cursor);
    operations.push(...response.operations);
    nextCursor = response.nextCursor;
    if (!nextCursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return { operations, nextCursor };
}

export async function getIntegrationStats(
  period: IntegrationPeriod,
): Promise<IntegrationStats> {
  const response = await authenticatedRequest(`/stats?period=${period}`, {
    method: "GET",
  });
  return parseResponse(response, IntegrationStatsSchema);
}

export async function deleteIntegrationHistory(
  operationId: string,
): Promise<void> {
  const response = await authenticatedRequest(
    `/history/${encodeURIComponent(operationId)}`,
    { method: "DELETE" },
  );
  await parseResponse(response, IntegrationDeleteResponseSchema);
}

export async function deleteIntegrationArchive(
  mediaSha256: Sha256,
): Promise<void> {
  const response = await authenticatedRequest(
    `/media/${encodeURIComponent(mediaSha256)}/archive`,
    { method: "DELETE" },
  );
  await parseResponse(response, IntegrationDeleteResponseSchema);
}

export async function deleteIntegrationMedia(
  mediaSha256: Sha256,
): Promise<void> {
  const response = await authenticatedRequest(
    `/media/${encodeURIComponent(mediaSha256)}`,
    { method: "DELETE" },
  );
  await parseResponse(response, IntegrationDeleteResponseSchema);
}

export async function clearIntegrationCache(): Promise<void> {
  const response = await authenticatedRequest("/cache", { method: "DELETE" });
  await parseResponse(response, IntegrationDeleteResponseSchema);
}

export async function saveIntegrationOutbox(
  entry: Omit<IntegrationOutboxEntry, "bytes" | "sessionId"> & {
    sessionId: string;
    bytes: Uint8Array;
  },
): Promise<void> {
  const limit =
    entry.input.action === "check"
      ? MAX_INTEGRATION_CHECK_BYTES
      : INTEGRATION_DOWNLOAD_MAX_BYTES;
  if (entry.bytes.byteLength > limit)
    throw new IntegrationClientError(
      "The selected media exceeds the connected-operation limit.",
      "media_too_large",
      false,
    );
  await withSessionLock(async () => {
    await requireIntegrationSession(entry.accountId, entry.sessionId);
    const database = await openOutboxDatabase();
    const value: IntegrationOutboxEntry = {
      ...entry,
      sessionId: entry.sessionId,
      bytes: new Blob([toArrayBuffer(entry.bytes)], {
        type: entry.input.media.mimeType,
      }),
    };
    await putOutboxEntry(
      database,
      `${entry.accountId}:${entry.operationId}`,
      value,
    );
  });
}

export async function getIntegrationOutbox(
  accountId: string,
  operationId: string,
): Promise<IntegrationOutboxEntry | null> {
  const database = await openOutboxDatabase();
  const value = await readOutboxEntry<IntegrationOutboxEntry>(
    database,
    `${accountId}:${operationId}`,
  );
  if (!value) return null;
  const expiresAt = outboxExpiration(value);
  if (expiresAt === null || expiresAt <= Date.now()) {
    await deleteOutboxEntry(database, `${accountId}:${operationId}`);
    return null;
  }
  return value;
}

export async function markIntegrationOutboxUploaded(
  accountId: string,
  operationId: string,
): Promise<void> {
  await withSessionLock(async () => {
    const database = await openOutboxDatabase();
    const key = `${accountId}:${operationId}`;
    const value = await readOutboxEntry<IntegrationOutboxEntry>(database, key);
    if (!value) return;
    await requireIntegrationSession(value.accountId, value.sessionId);
    value.bytes = null;
    await putOutboxEntry(database, key, value);
  });
}

export async function removeIntegrationOutbox(
  accountId: string,
  operationId: string,
): Promise<void> {
  const database = await openOutboxDatabase();
  await deleteOutboxEntry(database, `${accountId}:${operationId}`);
}

export async function saveIntegrationSegmentOutbox(
  entry: IntegrationSegmentOutboxEntry & { sessionId: string },
): Promise<void> {
  await withSessionLock(async () => {
    await requireIntegrationSession(entry.accountId, entry.sessionId);
    const database = await openOutboxDatabase();
    await putOutboxEntry(
      database,
      `${entry.accountId}:${SEGMENT_OUTBOX_PREFIX}${entry.operationId}`,
      entry,
    );
  });
}

export async function getIntegrationSegmentOutbox(
  accountId: string,
  operationId: string,
): Promise<IntegrationSegmentOutboxEntry | null> {
  const database = await openOutboxDatabase();
  const key = `${accountId}:${SEGMENT_OUTBOX_PREFIX}${operationId}`;
  const value = await readOutboxEntry<IntegrationSegmentOutboxEntry>(
    database,
    key,
  );
  if (!value) return null;
  const expiresAt = outboxExpiration(value);
  if (expiresAt === null || expiresAt <= Date.now()) {
    await deleteOutboxEntry(database, key);
    return null;
  }
  return value;
}

export async function removeIntegrationSegmentOutbox(
  accountId: string,
  operationId: string,
): Promise<void> {
  const database = await openOutboxDatabase();
  await deleteOutboxEntry(
    database,
    `${accountId}:${SEGMENT_OUTBOX_PREFIX}${operationId}`,
  );
}

export async function addPendingIntegrationOperation(
  pending: IntegrationPendingOperation,
): Promise<void> {
  await withSessionLock(async () => {
    await requireIntegrationSession(pending.accountId, pending.sessionId);
    const values = await chrome.storage.local.get(
      STORAGE_KEYS.pendingOperations,
    );
    const existing = readPendingOperations(
      values[STORAGE_KEYS.pendingOperations],
    );
    const next = existing.filter(
      (item) =>
        item.accountId !== pending.accountId ||
        item.operationId !== pending.operationId,
    );
    next.push(pending);
    await chrome.storage.local.set({ [STORAGE_KEYS.pendingOperations]: next });
  });
}

export async function removePendingIntegrationOperation(
  accountId: string,
  operationId: string,
): Promise<void> {
  await withSessionLock(async () => {
    const values = await chrome.storage.local.get(
      STORAGE_KEYS.pendingOperations,
    );
    const existing = readPendingOperations(
      values[STORAGE_KEYS.pendingOperations],
    );
    await chrome.storage.local.set({
      [STORAGE_KEYS.pendingOperations]: existing.filter(
        (item) =>
          item.accountId !== accountId || item.operationId !== operationId,
      ),
    });
  });
}

export async function listPendingIntegrationOperations(): Promise<
  IntegrationPendingOperation[]
> {
  const session = await getIntegrationSession();
  if (!session) return [];
  const values = await chrome.storage.local.get(STORAGE_KEYS.pendingOperations);
  return readPendingOperations(values[STORAGE_KEYS.pendingOperations]).filter(
    (item) =>
      item.accountId === session.accountId &&
      item.sessionId === session.sessionId,
  );
}

/**
 * Resume only durable connected-operation state after a service-worker restart.
 * The outbox is bounded and account-scoped; once media is accepted, only the
 * operation id remains and this path performs a single status read.
 */
export async function resumePendingIntegrationOperations(): Promise<void> {
  if (typeof indexedDB !== "undefined") await sweepIntegrationOutbox();
  const session = await getIntegrationSession();
  if (!session) return;
  const expected: IntegrationSessionExpectation = sessionExpectation(session);
  const values = await chrome.storage.local.get(STORAGE_KEYS.pendingOperations);
  const pending = readPendingOperations(values[STORAGE_KEYS.pendingOperations]);
  for (const operation of pending) {
    if (
      operation.accountId !== expected.accountId ||
      operation.sessionId !== expected.sessionId
    ) {
      await discardPendingIntegrationOperation(operation);
      continue;
    }
    const operationExpected: IntegrationSessionExpectation = {
      accountId: operation.accountId,
      sessionId: operation.sessionId,
    };
    try {
      const outbox = await getIntegrationOutbox(
        operation.accountId,
        operation.operationId,
      );
      let status: IntegrationOperationStatus;
      if (outbox?.bytes) {
        if (outbox.sessionId !== operationExpected.sessionId) {
          await discardPendingIntegrationOperation(operation);
          continue;
        }
        status = await createIntegrationOperation(
          outbox.input,
          outbox.createdAt,
          operationExpected,
        );
        if (status.state === "awaiting_upload") {
          status = await uploadIntegrationMedia(
            operation.operationId,
            new Uint8Array(await outbox.bytes.arrayBuffer()),
            outbox.input.media.mimeType,
            operationExpected,
          );
        }
        if (status.state !== "awaiting_upload")
          await markIntegrationOutboxUploaded(
            operation.accountId,
            operation.operationId,
          );
      } else {
        const segment = await getIntegrationSegmentOutbox(
          operation.accountId,
          operation.operationId,
        );
        if (segment) {
          if (segment.sessionId !== operationExpected.sessionId) {
            await discardPendingIntegrationOperation(operation);
            continue;
          }
          status = await createAudioSegmentOperation(
            operation.operationId,
            segment.sourceUrl,
            segment.startSeconds,
            segment.endSeconds,
            segment.createdAt,
            operationExpected,
          );
          await removeIntegrationSegmentOutbox(
            operation.accountId,
            operation.operationId,
          );
        } else {
          status = await getIntegrationOperationForSession(
            operation.operationId,
            operationExpected,
          );
        }
      }
      if (status.state === "completed" || status.state === "failed") {
        await removePendingIntegrationOperation(
          operation.accountId,
          operation.operationId,
        );
        await removeIntegrationOutbox(
          operation.accountId,
          operation.operationId,
        );
        await removeIntegrationSegmentOutbox(
          operation.accountId,
          operation.operationId,
        );
      }
    } catch (error: unknown) {
      // Retryable transport/provider failures remain pending for the next
      // startup. Permanent tombstone/auth errors cannot make progress.
      if (error instanceof IntegrationClientError && !error.retryable) {
        await discardPendingIntegrationOperation(operation);
      }
    }
  }
}

async function clearPendingOperations(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS.pendingOperations);
}

async function clearIntegrationStateUnlocked(): Promise<void> {
  await Promise.all([
    chrome.storage.local.remove(STORAGE_KEYS.session),
    chrome.storage.session.remove(STORAGE_KEYS.pendingPairing),
    clearIntegrationOutbox(),
    clearPendingOperations(),
  ]);
}

async function replaceIntegrationSession(
  session: IntegrationSession,
): Promise<void> {
  await withSessionLock(async () => {
    await Promise.all([
      chrome.storage.local.set({ [STORAGE_KEYS.session]: session }),
      chrome.storage.session.remove(STORAGE_KEYS.pendingPairing),
      clearIntegrationOutbox(),
      clearPendingOperations(),
    ]);
  });
}

async function clearIntegrationSessionIfCurrent(
  expected: IntegrationSession,
): Promise<void> {
  await withSessionLock(async () => {
    const current = await getIntegrationSession();
    if (current && sameSessionVersion(current, expected))
      await clearIntegrationStateUnlocked();
  });
}

async function getFreshSession(
  expected?: IntegrationSessionExpectation,
): Promise<IntegrationSession> {
  const session = await getIntegrationSession();
  if (!session) {
    if (expected) throw sessionChangedError();
    throw new IntegrationClientError(
      "Connect Provenance Lens to DigiBot before using connected actions.",
      "integration_not_connected",
      false,
    );
  }
  assertExpectedSession(session, expected);
  if (Date.parse(session.absoluteExpiresAt) <= Date.now()) {
    await clearIntegrationSessionIfCurrent(session);
    throw new IntegrationClientError(
      "The DigiBot connection has expired. Pair this browser again.",
      "integration_session_expired",
      false,
    );
  }
  if (Date.parse(session.accessExpiresAt) - EXPIRY_SKEW_MS > Date.now())
    return session;
  return (
    (await refreshSession(sessionExpectation(session), session.refreshToken)) ??
    session
  );
}

async function refreshSession(
  expected: IntegrationSessionExpectation,
  staleRefreshToken: string,
): Promise<IntegrationSession | null> {
  return withSessionLock(async () => {
    const current = await getIntegrationSession();
    if (!current) throw sessionChangedError();
    assertExpectedSession(current, expected);
    if (current.refreshToken !== staleRefreshToken) return current;
    const body = IntegrationRefreshRequestSchema.parse({
      refreshToken: current.refreshToken,
    });
    let next: IntegrationSession;
    try {
      const response = await requestUnauthenticated("/sessions/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      next = await parseResponse(response, IntegrationSessionResponseSchema);
    } catch (error: unknown) {
      if (error instanceof IntegrationClientError && !error.retryable) {
        const latest = await getIntegrationSession();
        if (latest && sameSessionVersion(latest, current))
          await clearIntegrationStateUnlocked();
      }
      throw error;
    }
    assertExpectedSession(next, expected);
    const latest = await getIntegrationSession();
    if (!latest || !sameSessionVersion(latest, current))
      throw sessionChangedError();
    await chrome.storage.local.set({ [STORAGE_KEYS.session]: next });
    return next;
  });
}

async function authenticatedRequest(
  path: string,
  init: RequestInit,
  retry = true,
  expected?: IntegrationSessionExpectation,
): Promise<Response> {
  const session = await getFreshSession(expected);
  const requestExpected = expected ?? sessionExpectation(session);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `${session.tokenType} ${session.accessToken}`);
  headers.set("Accept", "application/json");
  const response = await requestUnauthenticated(path, { ...init, headers });
  await requireIntegrationSession(
    requestExpected.accountId,
    requestExpected.sessionId,
  );
  if (response.status !== 401 || !retry) {
    if (!response.ok) throw await responseError(response);
    return response;
  }
  const refreshed = await refreshSession(requestExpected, session.refreshToken);
  if (!refreshed)
    throw new IntegrationClientError(
      "The DigiBot session expired.",
      "integration_session_expired",
      false,
      401,
    );
  const retryHeaders = new Headers(init.headers);
  retryHeaders.set(
    "Authorization",
    `${refreshed.tokenType} ${refreshed.accessToken}`,
  );
  retryHeaders.set("Accept", "application/json");
  const retried = await requestUnauthenticated(path, {
    ...init,
    headers: retryHeaders,
  });
  await requireIntegrationSession(
    requestExpected.accountId,
    requestExpected.sessionId,
  );
  if (!retried.ok) throw await responseError(retried);
  return retried;
}

async function operationSessionExpectation(
  operationId: string,
): Promise<IntegrationSessionExpectation> {
  const values = await chrome.storage.local.get(STORAGE_KEYS.pendingOperations);
  const pending = readPendingOperations(
    values[STORAGE_KEYS.pendingOperations],
  ).find((item) => item.operationId === operationId);
  const session = await requireIntegrationSession(
    pending?.accountId,
    pending?.sessionId,
  );
  return sessionExpectation(session);
}

async function requireIntegrationSession(
  accountId?: string,
  sessionId?: string,
): Promise<IntegrationSession> {
  const session = await getIntegrationSession();
  if (!session) {
    if (accountId || sessionId) throw sessionChangedError();
    throw new IntegrationClientError(
      "Connect Provenance Lens to DigiBot before using connected actions.",
      "integration_not_connected",
      false,
    );
  }
  if (
    (accountId !== undefined && session.accountId !== accountId) ||
    (sessionId !== undefined && session.sessionId !== sessionId)
  )
    throw sessionChangedError();
  return session;
}

function sessionExpectation(
  session: IntegrationSession,
): IntegrationSessionExpectation {
  return { accountId: session.accountId, sessionId: session.sessionId };
}

function assertExpectedSession(
  session: IntegrationSession,
  expected?: IntegrationSessionExpectation,
): void {
  if (
    expected &&
    (session.accountId !== expected.accountId ||
      session.sessionId !== expected.sessionId)
  )
    throw sessionChangedError();
}

function sameSessionVersion(
  left: IntegrationSession,
  right: IntegrationSession,
): boolean {
  return (
    left.accountId === right.accountId &&
    left.sessionId === right.sessionId &&
    left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken
  );
}

function sessionChangedError(): IntegrationClientError {
  return new IntegrationClientError(
    "The connected DigiBot account changed. Start the action again.",
    "integration_session_changed",
    false,
  );
}

function withSessionLock<T>(work: () => Promise<T>): Promise<T> {
  return navigator.locks.request(SESSION_LOCK, work);
}

async function discardPendingIntegrationOperation(
  operation: IntegrationPendingOperation,
): Promise<void> {
  await Promise.all([
    removePendingIntegrationOperation(
      operation.accountId,
      operation.operationId,
    ).catch(() => undefined),
    removeIntegrationOutbox(operation.accountId, operation.operationId).catch(
      () => undefined,
    ),
    removeIntegrationSegmentOutbox(
      operation.accountId,
      operation.operationId,
    ).catch(() => undefined),
  ]);
}

async function requestUnauthenticated(
  path: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    const headers = new Headers(init.headers);
    headers.set("X-Integration-Client-Origin", integrationClientOrigin());
    response = await fetch(`${INTEGRATION_API_BASE_URL}${path}`, {
      ...init,
      headers,
      credentials: "omit",
    });
  } catch {
    throw new IntegrationClientError(
      "The DigiBot integration server could not be reached.",
      "integration_unavailable",
      true,
    );
  }
  return response;
}

function integrationClientOrigin(): string {
  return `chrome-extension://${chrome.runtime.id}`;
}

async function responseError(
  response: Response,
): Promise<IntegrationClientError> {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Keep the bounded fallback below.
  }
  const parsed =
    typeof payload === "object" && payload !== null && "error" in payload
      ? IntegrationApiErrorSchema.safeParse(payload.error)
      : null;
  if (parsed?.success)
    return new IntegrationClientError(
      parsed.data.message,
      parsed.data.code,
      parsed.data.retryable,
      response.status,
    );
  return new IntegrationClientError(
    `The DigiBot integration server returned HTTP ${response.status}.`,
    response.status >= 500
      ? "integration_unavailable"
      : "integration_request_failed",
    response.status >= 500,
    response.status,
  );
}

async function parseResponse<T>(
  response: Response,
  schema: { parse: (value: unknown) => T },
): Promise<T> {
  if (!response.ok) throw await responseError(response);
  const payload = (await response.json()) as unknown;
  return schema.parse(payload);
}

function createVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");
}

function isPendingPairing(value: unknown): value is PendingPairing {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["pairId"] === "string" &&
    typeof candidate["confirmationCode"] === "string" &&
    typeof candidate["expiresAt"] === "string" &&
    typeof candidate["verifier"] === "string" &&
    typeof candidate["deviceName"] === "string"
  );
}

function readPendingOperations(value: unknown): IntegrationPendingOperation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      return [];
    const candidate = item as Record<string, unknown>;
    return typeof candidate["accountId"] === "string" &&
      typeof candidate["operationId"] === "string" &&
      typeof candidate["createdAt"] === "string" &&
      typeof candidate["sessionId"] === "string"
      ? [
          {
            accountId: candidate["accountId"],
            sessionId: candidate["sessionId"],
            operationId: candidate["operationId"],
            createdAt: candidate["createdAt"],
          },
        ]
      : [];
  });
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    if (!signal) return;
    const abort = (): void => {
      clearTimeout(timer);
      reject(
        new IntegrationClientError(
          "The connected operation was cancelled.",
          "user_cancelled",
          false,
        ),
      );
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function openOutboxDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OUTBOX_DATABASE, OUTBOX_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(OUTBOX_STORE))
        request.result.createObjectStore(OUTBOX_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Unable to open integration outbox."));
  });
}

async function putOutboxEntry(
  database: IDBDatabase,
  key: string,
  value: unknown,
): Promise<void> {
  const now = Date.now();
  const expiresAt = outboxExpiration(value);
  if (expiresAt === null || expiresAt <= now)
    throw new IntegrationClientError(
      "The pending connected operation has expired.",
      "integration_outbox_expired",
      false,
    );
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(OUTBOX_STORE, "readwrite");
    const store = transaction.objectStore(OUTBOX_STORE);
    const request = store.openCursor();
    let count = 0;
    let totalBytes = 0;
    let failure: Error | null = null;
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        const existingExpiry = outboxExpiration(cursor.value);
        if (existingExpiry === null || existingExpiry <= now) cursor.delete();
        else if (cursor.key !== key) {
          count += 1;
          totalBytes += outboxBytes(cursor.value);
        }
        cursor.continue();
        return;
      }
      const nextBytes = totalBytes + outboxBytes(value);
      if (
        count + 1 > MAX_OUTBOX_ENTRIES ||
        nextBytes > MAX_OUTBOX_TOTAL_BYTES
      ) {
        failure = new IntegrationClientError(
          "Too much pending connected media is stored. Retry or remove an older operation first.",
          "integration_outbox_limit",
          false,
        );
        transaction.abort();
        return;
      }
      store.put(value, key);
    };
    request.onerror = () => {
      failure =
        request.error ?? new Error("Unable to inspect integration outbox.");
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        failure ??
          transaction.error ??
          new Error("Unable to save integration outbox."),
      );
    transaction.onabort = () =>
      reject(
        failure ??
          transaction.error ??
          new Error("Unable to save integration outbox."),
      );
  });
}

async function sweepIntegrationOutbox(): Promise<void> {
  const database = await openOutboxDatabase();
  const now = Date.now();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(OUTBOX_STORE, "readwrite");
    const request = transaction.objectStore(OUTBOX_STORE).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const expiresAt = outboxExpiration(cursor.value);
      if (expiresAt === null || expiresAt <= now) cursor.delete();
      cursor.continue();
    };
    request.onerror = () =>
      reject(
        request.error ?? new Error("Unable to inspect integration outbox."),
      );
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        transaction.error ?? new Error("Unable to sweep integration outbox."),
      );
  });
}

function outboxExpiration(value: unknown): number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const expiresAt = (value as Record<string, unknown>)["expiresAt"];
  if (typeof expiresAt !== "string") return null;
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function outboxBytes(value: unknown): number {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return 0;
  const bytes = (value as Record<string, unknown>)["bytes"];
  return bytes instanceof Blob ? bytes.size : 0;
}

async function readOutboxEntry<T>(
  database: IDBDatabase,
  key: string,
): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const request = database
      .transaction(OUTBOX_STORE, "readonly")
      .objectStore(OUTBOX_STORE)
      .get(key);
    request.onsuccess = () =>
      resolve((request.result as T | undefined) ?? null);
    request.onerror = () =>
      reject(request.error ?? new Error("Unable to read integration outbox."));
  });
}

async function deleteOutboxEntry(
  database: IDBDatabase,
  key: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = database
      .transaction(OUTBOX_STORE, "readwrite")
      .objectStore(OUTBOX_STORE)
      .delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(
        request.error ?? new Error("Unable to delete integration outbox."),
      );
  });
}

export async function clearIntegrationOutbox(): Promise<void> {
  const database = await openOutboxDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = database
      .transaction(OUTBOX_STORE, "readwrite")
      .objectStore(OUTBOX_STORE)
      .clear();
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error("Unable to clear integration outbox."));
  });
}

export async function hashIntegrationMedia(bytes: Uint8Array): Promise<Sha256> {
  return sha256Hex(bytes);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
