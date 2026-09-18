import {
  AUDIO_ACTION_ID,
  AudioValidationError,
  CacheLookupRequestSchema,
  CacheLookupResponseSchema,
  CacheMetadataSchema,
  ErrorCodeSchema,
  HistoryRecordSchema,
  MAX_AUDIO_BYTES,
  makeIndeterminateResult,
  RESULT_SCHEMA_VERSION,
  ServerErrorResponseSchema,
  VERIFICATION_POLICY_VERSION,
  VerificationResponseSchema,
  validateAudioBlob,
  sanitizedAudioFilename,
  sha256Hex,
  parseBackendBaseUrl,
  type CacheLookupRequest,
  type CacheMetadata,
  type ErrorCode,
  type ExtensionSettings,
  type HistoryRecord,
  type NormalizedProvenanceResult,
  type Sha256,
  type SupportedAudioMime,
  type VerificationResponse,
} from "@provenance-lens/shared";

import { findLocalCache, isCacheableResult, saveLocalCache } from "../cache.js";
import {
  readBoundedResponseBytes,
  ResponseBodyTooLargeError,
} from "../bounded-response.js";

const MAX_RESPONSE_BYTES = 128 * 1024;
const BACKEND_TIMEOUT_MS = 30_000;

export async function openAudioCheck(): Promise<void> {
  let sourceUrl: string | null = null;
  try {
    const tabs = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    const candidate = tabs[0]?.url;
    if (candidate) {
      const parsed = new URL(candidate);
      if (
        ["http:", "https:"].includes(parsed.protocol) &&
        !parsed.username &&
        !parsed.password
      )
        sourceUrl = parsed.toString();
    }
  } catch {
    // The audio page still supports manually entering a video URL.
  }
  const page = new URL(chrome.runtime.getURL("audio.html"));
  if (sourceUrl) page.searchParams.set("source", sourceUrl);
  await chrome.tabs.create({ url: page.toString() });
}

export interface AudioVerificationContext {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  forceRecheck?: boolean;
}

export interface AudioVerificationOutcome {
  result: NormalizedProvenanceResult;
  imageSha256: Sha256 | null;
  cache: CacheMetadata | null;
  errorCode: ErrorCode | null;
}

export class AudioWorkflowError extends Error {
  public constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "AudioWorkflowError";
  }
}

export async function verifyAudioFile(
  file: File,
  settings: ExtensionSettings,
  context: AudioVerificationContext = {},
): Promise<AudioVerificationOutcome> {
  let bytes: Uint8Array | null = null;
  let imageSha256: Sha256 | null = null;
  try {
    throwIfAborted(context.signal);
    if (!Number.isSafeInteger(file.size) || file.size === 0) {
      throw new AudioWorkflowError(
        "unsupported_audio_type",
        "Choose a non-empty supported audio file.",
      );
    }
    if (file.size > MAX_AUDIO_BYTES) {
      throw new AudioWorkflowError(
        "audio_too_large",
        `The audio is larger than ${MAX_AUDIO_BYTES / (1024 * 1024)} MiB.`,
      );
    }
    const validation = await validateAudioBlob(file, file.type);
    bytes = new Uint8Array(await file.arrayBuffer());
    imageSha256 = await sha256Hex(bytes);
    const metadata: CacheLookupRequest = CacheLookupRequestSchema.parse({
      imageSha256,
      byteLength: bytes.byteLength,
      validatedMimeType: validation.mime,
      verificationPolicyVersion: VERIFICATION_POLICY_VERSION,
    });

    if (!context.forceRecheck) {
      const local = await findLocalCache(settings, metadata).catch(() => null);
      if (local)
        return outcome(
          assertAudioResult(local.result),
          imageSha256,
          local.cache,
        );
      const server = await lookupServerCache(settings, metadata, context);
      if (server) {
        const result = assertAudioResult(server.result);
        await saveLocalCache(
          settings,
          metadata,
          server.result,
          server.cache,
        ).catch(() => undefined);
        return outcome(result, imageSha256, server.cache);
      }
    }

    const response = await verifyAudioWithBackend(
      bytes,
      validation.mime,
      settings,
      { ...context, imageSha256 },
    );
    const result = assertAudioResult(response.result);
    if (isCacheableResult(result) && response.cache) {
      await saveLocalCache(settings, metadata, result, response.cache).catch(
        () => undefined,
      );
    }
    return outcome(result, imageSha256, response.cache);
  } catch (error) {
    const normalized = toAudioError(error);
    return {
      result: makeIndeterminateResult(normalized.message),
      imageSha256,
      cache: null,
      errorCode: normalized.code,
    };
  } finally {
    bytes?.fill(0);
  }
}

export function createAudioHistoryRecord(
  outcome: AudioVerificationOutcome,
): HistoryRecord {
  return HistoryRecordSchema.parse({
    id: crypto.randomUUID(),
    actionId: AUDIO_ACTION_ID,
    createdAt: new Date().toISOString(),
    sourceHostname: "local file",
    pageTitle: null,
    mediaKind: "audio",
    inputKind: "original_file",
    imageSha256: outcome.imageSha256,
    result: outcome.result,
    cache: outcome.cache,
    errorCode: outcome.errorCode,
    manualFallbackAvailable: false,
    screenshotFallbackAvailable: false,
  });
}

async function verifyAudioWithBackend(
  bytes: Uint8Array,
  mime: SupportedAudioMime,
  settings: ExtensionSettings,
  context: AudioVerificationContext & { imageSha256: Sha256 },
): Promise<VerificationResponse> {
  return withDeadline(context.signal, (signal) =>
    verifyAudioWithBackendUnbounded(bytes, mime, settings, {
      ...context,
      signal,
    }),
  );
}

async function verifyAudioWithBackendUnbounded(
  bytes: Uint8Array,
  mime: SupportedAudioMime,
  settings: ExtensionSettings,
  context: AudioVerificationContext & {
    imageSha256: Sha256;
    signal?: AbortSignal;
  },
): Promise<VerificationResponse> {
  throwIfAborted(context.signal);
  const token = settings.clientToken.trim();
  if (!token)
    throw new AudioWorkflowError(
      "backend_configuration_missing",
      "Configure the backend client token before verifying audio.",
    );
  let endpoint: URL;
  try {
    endpoint = parseBackendBaseUrl(settings.backendBaseUrl);
  } catch {
    throw new AudioWorkflowError(
      "backend_configuration_missing",
      "Configure a valid verification server URL in Settings.",
    );
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/u, "")}/api/verify-audio`;
  endpoint.search = "";
  endpoint.hash = "";

  const form = new FormData();
  form.append(
    "file",
    new Blob([toArrayBuffer(bytes)], { type: mime }),
    sanitizedAudioFilename(mime),
  );
  form.append("imageSha256", context.imageSha256);
  form.append("byteLength", String(bytes.byteLength));
  form.append("validatedMimeType", mime);
  form.append("verificationPolicyVersion", VERIFICATION_POLICY_VERSION);
  form.append("forceRecheck", String(Boolean(context.forceRecheck)));

  let response: Response;
  try {
    const requestInit: RequestInit = {
      method: "POST",
      body: form,
      credentials: "omit",
      headers: { Authorization: `Bearer ${token}` },
    };
    if (context.signal) requestInit.signal = context.signal;
    response = await (context.fetchImpl ?? fetch)(endpoint, requestInit);
  } catch (error) {
    if (isAbortError(error))
      throw new AudioWorkflowError(
        "request_timeout",
        "The audio verification request timed out.",
        true,
      );
    throw new AudioWorkflowError(
      "backend_unavailable",
      "The verification server is unavailable.",
      true,
    );
  }
  const payload = await parseJsonResponse(response, context.signal);
  if (response.ok) {
    const parsed = VerificationResponseSchema.safeParse(payload);
    if (!parsed.success)
      throw new AudioWorkflowError(
        "invalid_api_response",
        "The verification server returned an invalid result.",
      );
    if (
      parsed.data.cache &&
      (parsed.data.cache.verificationPolicyVersion !==
        VERIFICATION_POLICY_VERSION ||
        parsed.data.cache.resultSchemaVersion !== RESULT_SCHEMA_VERSION ||
        (context.forceRecheck && parsed.data.cache.source !== "fresh"))
    ) {
      throw new AudioWorkflowError(
        "cache_policy_mismatch",
        "The verification server returned an incompatible cache policy.",
      );
    }
    return parsed.data;
  }
  const errorResponse = ServerErrorResponseSchema.safeParse(payload);
  if (!errorResponse.success)
    throw new AudioWorkflowError(
      response.status >= 500 ? "backend_unavailable" : "invalid_api_response",
      "The verification server returned an invalid error response.",
      response.status >= 500,
    );
  const serverError = errorResponse.data.error;
  const code = ErrorCodeSchema.safeParse(serverError.code);
  if (!code.success)
    throw new AudioWorkflowError(
      "invalid_api_response",
      "The verification server returned an unknown error.",
    );
  throw new AudioWorkflowError(
    code.data,
    serverError.message,
    serverError.retryable,
  );
}

async function lookupServerCache(
  settings: ExtensionSettings,
  metadata: CacheLookupRequest,
  context: AudioVerificationContext,
): Promise<{
  result: NormalizedProvenanceResult;
  cache: CacheMetadata;
} | null> {
  return withDeadline(context.signal, (signal) =>
    lookupServerCacheUnbounded(settings, metadata, { ...context, signal }),
  );
}

async function lookupServerCacheUnbounded(
  settings: ExtensionSettings,
  metadata: CacheLookupRequest,
  context: AudioVerificationContext & { signal?: AbortSignal },
): Promise<{
  result: NormalizedProvenanceResult;
  cache: CacheMetadata;
} | null> {
  throwIfAborted(context.signal);
  const token = settings.clientToken.trim();
  if (!token)
    throw new AudioWorkflowError(
      "backend_configuration_missing",
      "Configure the backend client token before verifying audio.",
    );
  let endpoint: URL;
  try {
    endpoint = parseBackendBaseUrl(settings.backendBaseUrl);
  } catch {
    throw new AudioWorkflowError(
      "backend_configuration_missing",
      "Configure a valid verification server URL in Settings.",
    );
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/u, "")}/api/cache/lookup`;
  endpoint.search = "";
  endpoint.hash = "";
  let response: Response;
  try {
    const requestInit: RequestInit = {
      method: "POST",
      credentials: "omit",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(metadata),
    };
    if (context.signal) requestInit.signal = context.signal;
    response = await (context.fetchImpl ?? fetch)(endpoint, requestInit);
  } catch (error) {
    if (isAbortError(error))
      throw new AudioWorkflowError(
        "request_timeout",
        "The audio verification request timed out.",
        true,
      );
    throw new AudioWorkflowError(
      "backend_unavailable",
      "The verification server is unavailable.",
      true,
    );
  }
  const payload = await parseJsonResponse(response, context.signal);
  if (!response.ok)
    throw new AudioWorkflowError(
      response.status >= 500 ? "backend_unavailable" : "cache_unavailable",
      "The verification cache returned an invalid response.",
      response.status >= 500,
    );
  const parsed = CacheLookupResponseSchema.safeParse(payload);
  if (!parsed.success)
    throw new AudioWorkflowError(
      "cache_unavailable",
      "The verification cache returned an invalid response.",
      true,
    );
  if (!parsed.data.hit) return null;
  if (
    parsed.data.verificationPolicyVersion !== VERIFICATION_POLICY_VERSION ||
    parsed.data.resultSchemaVersion !== RESULT_SCHEMA_VERSION ||
    Date.parse(parsed.data.expiresAt) <= Date.now()
  )
    return null;
  return {
    result: parsed.data.result,
    cache: CacheMetadataSchema.parse({
      source: "server_cache",
      originallyCheckedAt: parsed.data.originallyCheckedAt,
      expiresAt: parsed.data.expiresAt,
      verificationPolicyVersion: parsed.data.verificationPolicyVersion,
      resultSchemaVersion: parsed.data.resultSchemaVersion,
    }),
  };
}

async function parseJsonResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES)
    throw new AudioWorkflowError(
      "invalid_api_response",
      "The verification server response is too large.",
    );
  try {
    const bytes = await readBoundedResponseBytes(
      response,
      MAX_RESPONSE_BYTES,
      signal,
    );
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    if (signal?.aborted)
      throw new AudioWorkflowError(
        "request_timeout",
        "The audio verification request timed out.",
        true,
      );
    if (error instanceof ResponseBodyTooLargeError)
      throw new AudioWorkflowError(
        "invalid_api_response",
        "The verification server response is too large.",
      );
    throw new AudioWorkflowError(
      "invalid_api_response",
      "The verification server returned invalid JSON.",
    );
  }
}

function outcome(
  result: NormalizedProvenanceResult,
  imageSha256: Sha256,
  cache: CacheMetadata | null,
): AudioVerificationOutcome {
  return {
    result,
    imageSha256,
    cache,
    errorCode:
      result.verdict === "indeterminate" ? "invalid_api_response" : null,
  };
}

function assertAudioResult(
  result: NormalizedProvenanceResult,
): NormalizedProvenanceResult {
  if (
    result.contentCredentials !== undefined ||
    result.signals.some((signal) => signal.type !== "synthid")
  ) {
    throw new AudioWorkflowError(
      "invalid_api_response",
      "The audio verification response contained unsupported provenance evidence.",
    );
  }
  return result;
}

function toAudioError(error: unknown): AudioWorkflowError {
  if (error instanceof AudioWorkflowError) return error;
  if (error instanceof AudioValidationError)
    return new AudioWorkflowError(error.code, error.message);
  return new AudioWorkflowError(
    "backend_unavailable",
    "The audio could not be verified.",
    true,
  );
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

async function withDeadline<T>(
  parentSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  throwIfAborted(parentSignal);
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let parentAbort: (() => void) | undefined;
  const parentPromise = parentSignal
    ? new Promise<never>((_, reject) => {
        parentAbort = () => {
          controller.abort();
          reject(
            new AudioWorkflowError(
              "user_cancelled",
              "Verification cancelled by the user.",
            ),
          );
        };
        if (parentSignal.aborted) parentAbort();
        else
          parentSignal.addEventListener("abort", parentAbort, { once: true });
      })
    : null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(
        new AudioWorkflowError(
          "request_timeout",
          "The audio verification request timed out.",
          true,
        ),
      );
    }, BACKEND_TIMEOUT_MS);
  });
  try {
    const operationPromise = operation(controller.signal);
    return await Promise.race(
      parentPromise
        ? [operationPromise, timeoutPromise, parentPromise]
        : [operationPromise, timeoutPromise],
    );
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (parentSignal && parentAbort)
      parentSignal.removeEventListener("abort", parentAbort);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new AudioWorkflowError(
      "user_cancelled",
      "Verification cancelled by the user.",
    );
  }
}
