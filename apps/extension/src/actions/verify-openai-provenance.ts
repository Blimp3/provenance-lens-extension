import {
  CacheLookupRequestSchema,
  CacheLookupResponseSchema,
  CacheMetadataSchema,
  ErrorCodeSchema,
  HistoryRecordSchema,
  ImageSelectionSchema,
  MAX_IMAGE_BYTES,
  IMAGE_RESULT_SCHEMA_VERSION,
  ServerErrorResponseSchema,
  IMAGE_VERIFICATION_POLICY_VERSION,
  VerificationResponseSchema,
  VerificationUploadMetadataSchema,
  makeIndeterminateResult,
  parseAllowedImageUrl,
  parseBackendBaseUrl,
  sanitizedImageFilename,
  sanitizeDisplayText,
  validateImageBytes,
  sha256Hex,
  type ErrorCode,
  type CacheLookupRequest,
  type CacheMetadata,
  type ExtensionSettings,
  type HistoryRecord,
  type ImageSelection,
  type NormalizedProvenanceResult,
  type Sha256,
  type SupportedImageMime,
  type VerificationResponse,
} from "@provenance-lens/shared";

import { findLocalCache, isCacheableResult, saveLocalCache } from "../cache.js";
import {
  readBoundedResponseBytes,
  ResponseBodyTooLargeError,
} from "../bounded-response.js";

const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_REDIRECTS = 5;
const RETRIEVAL_TIMEOUT_MS = 30_000;
const BACKEND_TIMEOUT_MS = 30_000;
const DEADLINE_REASON = "provenance-lens-deadline";

export const USER_CANCELLED_REASON = "provenance-lens-user-cancelled";

export interface ImageRetrievalContext {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  hasHostPermission?: (url: URL) => Promise<boolean>;
}

export interface RetrievedImage {
  bytes: Uint8Array;
  mime: SupportedImageMime;
  filename: string;
  sourceUrl: string;
}

export interface VerificationOutcome {
  result: NormalizedProvenanceResult;
  imageSha256: Sha256 | null;
  cache: CacheMetadata | null;
  errorCode: ErrorCode | null;
  retrieved: RetrievedImage | null;
  manualFallbackAvailable: boolean;
  screenshotFallbackAvailable: boolean;
}

export class ExtensionWorkflowError extends Error {
  public constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "ExtensionWorkflowError";
  }
}

export async function retrieveSelectedImage(
  input: ImageSelection,
  context: ImageRetrievalContext = {},
): Promise<RetrievedImage> {
  return withDeadline(context.signal, RETRIEVAL_TIMEOUT_MS, (signal) =>
    retrieveSelectedImageUnbounded(input, { ...context, signal }),
  );
}

async function retrieveSelectedImageUnbounded(
  input: ImageSelection,
  context: ImageRetrievalContext,
): Promise<RetrievedImage> {
  const parsedSelection = ImageSelectionSchema.safeParse(input);
  if (!parsedSelection.success) {
    throw new ExtensionWorkflowError(
      "image_retrieval_failed",
      "The selected image information is invalid.",
    );
  }
  const selection = parsedSelection.data;
  const fetchImpl = context.fetchImpl ?? fetch;
  const selectionUrl = parseAllowedImageUrl(selection.url);

  if (selection.inlineBase64 && selection.inlineMime) {
    const bytes = decodeBase64(selection.inlineBase64);
    const mime = validateBytes(bytes, selection.inlineMime);
    return {
      bytes,
      mime,
      filename: sanitizedImageFilename(mime),
      sourceUrl: selection.url,
    };
  }

  if (selectionUrl.protocol === "blob:") {
    throw new ExtensionWorkflowError(
      "image_retrieval_failed",
      "This blob image could not be retrieved as the original file. Enable screenshot fallback if needed.",
    );
  }

  await assertHostPermission(
    selectionUrl,
    selection.pageOrigin,
    context.hasHostPermission,
  );
  const response = await fetchWithRedirectChecks(
    selectionUrl,
    fetchImpl,
    context,
    selection.pageOrigin,
  );
  if (!response.ok) {
    throw new ExtensionWorkflowError(
      "image_retrieval_failed",
      "The selected image could not be retrieved from the page.",
    );
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && isOversizedContentLength(contentLength)) {
    throw new ExtensionWorkflowError(
      "image_too_large",
      "The selected image is larger than 50 MiB.",
    );
  }

  const bytes = await readResponseBytes(response, context.signal);
  const declaredMime = response.headers.get("content-type") ?? "";
  const mime = validateBytes(bytes, declaredMime);
  const sourceUrl = response.url || selection.url;
  return {
    bytes,
    mime,
    filename: sanitizedImageFilename(mime),
    sourceUrl,
  };
}

export interface BackendVerificationContext {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  forceRecheck?: boolean;
  imageSha256?: Sha256;
}

export async function verifyImageWithBackend(
  image: RetrievedImage,
  settings: ExtensionSettings,
  context: BackendVerificationContext = {},
): Promise<VerificationResponse> {
  return withDeadline(context.signal, BACKEND_TIMEOUT_MS, (signal) =>
    verifyImageWithBackendUnbounded(image, settings, { ...context, signal }),
  );
}

async function verifyImageWithBackendUnbounded(
  image: RetrievedImage,
  settings: ExtensionSettings,
  context: BackendVerificationContext,
): Promise<VerificationResponse> {
  const fetchImpl = context.fetchImpl ?? fetch;
  const token = settings.clientToken.trim();
  if (!token) {
    throw new ExtensionWorkflowError(
      "backend_configuration_missing",
      "Configure the backend client token before verifying an image.",
    );
  }

  let endpoint: URL;
  try {
    endpoint = parseBackendBaseUrl(settings.backendBaseUrl);
  } catch {
    throw new ExtensionWorkflowError(
      "backend_configuration_missing",
      "Configure a valid verification server URL in Settings.",
    );
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/u, "")}/api/verify-image/v2`;
  endpoint.search = "";
  endpoint.hash = "";

  const form = new FormData();
  const blob = new Blob([toArrayBuffer(image.bytes)], { type: image.mime });
  form.append("file", blob, image.filename);
  const computedImageSha256 = await sha256Hex(image.bytes);
  if (context.imageSha256 && context.imageSha256 !== computedImageSha256) {
    throw new ExtensionWorkflowError(
      "hash_mismatch",
      "The image hash does not match the exact bytes being uploaded.",
    );
  }
  const imageSha256 = computedImageSha256;
  const metadata = VerificationUploadMetadataSchema.parse({
    imageSha256,
    byteLength: image.bytes.byteLength,
    validatedMimeType: image.mime,
    verificationPolicyVersion: IMAGE_VERIFICATION_POLICY_VERSION,
    forceRecheck: Boolean(context.forceRecheck),
  });
  form.append("imageSha256", metadata.imageSha256);
  form.append("byteLength", String(metadata.byteLength));
  form.append("validatedMimeType", metadata.validatedMimeType);
  form.append("verificationPolicyVersion", metadata.verificationPolicyVersion);
  form.append("forceRecheck", String(metadata.forceRecheck));

  const requestInit: RequestInit = {
    method: "POST",
    body: form,
    credentials: "omit",
    headers: { Authorization: `Bearer ${token}` },
  };
  if (context.signal) requestInit.signal = context.signal;

  let response: Response;
  try {
    response = await fetchImpl(endpoint, requestInit);
  } catch (error: unknown) {
    if (isUserCancellation(context.signal)) {
      throw new ExtensionWorkflowError(
        "user_cancelled",
        "Verification cancelled by the user.",
      );
    }
    if (isAbortError(error)) {
      throw new ExtensionWorkflowError(
        "request_timeout",
        "The verification request was cancelled or timed out.",
        true,
      );
    }
    throw new ExtensionWorkflowError(
      "backend_unavailable",
      "The verification server is unavailable.",
      true,
    );
  }

  const payload = await parseJsonResponse(response, context.signal);
  if (response.ok) {
    const parsed = VerificationResponseSchema.safeParse(payload);
    if (!parsed.success || !parsed.data.result.contentCredentials) {
      throw new ExtensionWorkflowError(
        "invalid_api_response",
        "The verification server returned an invalid result.",
      );
    }
    if (
      parsed.data.cache &&
      (parsed.data.cache.verificationPolicyVersion !==
        IMAGE_VERIFICATION_POLICY_VERSION ||
        parsed.data.cache.resultSchemaVersion !== IMAGE_RESULT_SCHEMA_VERSION ||
        (context.forceRecheck && parsed.data.cache.source !== "fresh"))
    ) {
      throw new ExtensionWorkflowError(
        "cache_policy_mismatch",
        "The verification server returned an incompatible cache policy.",
      );
    }
    return parsed.data;
  }

  const errorResponse = ServerErrorResponseSchema.safeParse(payload);
  if (!errorResponse.success) {
    throw new ExtensionWorkflowError(
      response.status >= 500 ? "backend_unavailable" : "invalid_api_response",
      "The verification server returned an invalid error response.",
      response.status >= 500,
    );
  }
  const serverError = errorResponse.data.error;
  const errorCode = ErrorCodeSchema.safeParse(serverError.code);
  if (!errorCode.success) {
    throw new ExtensionWorkflowError(
      "invalid_api_response",
      "The verification server returned an unknown error.",
    );
  }
  throw new ExtensionWorkflowError(
    errorCode.data,
    serverError.message,
    serverError.retryable,
  );
}

export async function verifySelection(
  selection: ImageSelection,
  settings: ExtensionSettings,
  context: ImageRetrievalContext & {
    screenshotFallbackAvailable?: boolean;
  } = {},
): Promise<VerificationOutcome> {
  let retrieved: RetrievedImage;
  try {
    retrieved = await retrieveSelectedImage(selection, context);
  } catch (error: unknown) {
    const workflowError = toWorkflowError(
      error,
      "The selected image could not be retrieved.",
      "image_retrieval_failed",
    );
    const result = makeIndeterminateResult(workflowError.message);
    return {
      result,
      imageSha256: null,
      cache: null,
      errorCode: workflowError.code,
      retrieved: null,
      manualFallbackAvailable: false,
      screenshotFallbackAvailable: Boolean(
        settings.screenshotFallbackEnabled &&
        context.screenshotFallbackAvailable,
      ),
    };
  }

  return verifyRetrievedImage(retrieved, settings, context);
}

export async function verifyRetrievedImage(
  image: RetrievedImage,
  settings: ExtensionSettings,
  context: BackendVerificationContext & {
    screenshotFallbackAvailable?: boolean;
  } = {},
): Promise<VerificationOutcome> {
  let exactImageSha256: Sha256 | null = null;
  try {
    exactImageSha256 = await sha256Hex(image.bytes);
    if (
      context.imageSha256 !== undefined &&
      context.imageSha256 !== exactImageSha256
    ) {
      throw new ExtensionWorkflowError(
        "hash_mismatch",
        "The supplied image hash does not match the exact image bytes.",
      );
    }
    const imageSha256 = exactImageSha256;
    const metadata: CacheLookupRequest = CacheLookupRequestSchema.parse({
      imageSha256,
      byteLength: image.bytes.byteLength,
      validatedMimeType: image.mime,
      verificationPolicyVersion: IMAGE_VERIFICATION_POLICY_VERSION,
    });

    if (!context.forceRecheck) {
      let localHit;
      try {
        localHit = await findLocalCache(settings, metadata);
      } catch {
        localHit = null;
      }
      if (localHit) {
        return {
          result: localHit.result,
          imageSha256,
          cache: localHit.cache,
          errorCode: null,
          retrieved: image,
          manualFallbackAvailable: false,
          screenshotFallbackAvailable: false,
        };
      }

      const serverHit = await lookupServerCache(settings, metadata, context);
      if (serverHit) {
        try {
          await saveLocalCache(
            settings,
            metadata,
            serverHit.result,
            serverHit.cache,
          );
        } catch {
          // The local cache is an optimization; a valid server result remains usable.
        }
        return {
          result: serverHit.result,
          imageSha256,
          cache: serverHit.cache,
          errorCode: null,
          retrieved: image,
          manualFallbackAvailable: false,
          screenshotFallbackAvailable: false,
        };
      }
    }

    const response = await verifyImageWithBackend(image, settings, {
      ...context,
      imageSha256,
    });
    if (isCacheableResult(response.result) && response.cache) {
      try {
        await saveLocalCache(
          settings,
          metadata,
          response.result,
          response.cache,
        );
      } catch {
        // The local cache is an optimization; a valid server result remains usable.
      }
    }
    return {
      result: response.result,
      imageSha256,
      cache: response.cache,
      errorCode:
        response.result.verdict === "indeterminate"
          ? "invalid_api_response"
          : null,
      retrieved: image,
      manualFallbackAvailable: false,
      screenshotFallbackAvailable: false,
    };
  } catch (error: unknown) {
    const workflowError = toWorkflowError(
      error,
      "The image could not be verified.",
      "backend_unavailable",
    );
    return {
      result: makeIndeterminateResult(workflowError.message),
      imageSha256: exactImageSha256,
      cache: null,
      errorCode: workflowError.code,
      retrieved: image,
      manualFallbackAvailable: canOfferManualFallback(workflowError.code),
      screenshotFallbackAvailable: Boolean(
        settings.screenshotFallbackEnabled &&
        context.screenshotFallbackAvailable,
      ),
    };
  }
}

export function createHistoryRecord(
  selection: Pick<ImageSelection, "sourceHostname" | "pageTitle">,
  outcome: VerificationOutcome,
  includePageTitle: boolean,
  inputKind: "original_file" | "screenshot_copy" = "original_file",
): HistoryRecord {
  const record: HistoryRecord = {
    id: crypto.randomUUID(),
    actionId: "verify-openai-provenance",
    createdAt: new Date().toISOString(),
    sourceHostname: sanitizeDisplayText(
      selection.sourceHostname || "unknown",
      255,
    ),
    pageTitle:
      includePageTitle && selection.pageTitle
        ? sanitizeDisplayText(selection.pageTitle, 256)
        : null,
    inputKind,
    imageSha256: outcome.imageSha256,
    result: outcome.result,
    cache: outcome.cache,
    errorCode: outcome.errorCode,
    manualFallbackAvailable: outcome.manualFallbackAvailable,
    screenshotFallbackAvailable: outcome.screenshotFallbackAvailable,
  };
  return HistoryRecordSchema.parse(record);
}

async function lookupServerCache(
  settings: ExtensionSettings,
  metadata: CacheLookupRequest,
  context: BackendVerificationContext,
): Promise<{
  result: NormalizedProvenanceResult;
  cache: CacheMetadata;
} | null> {
  return withDeadline(context.signal, BACKEND_TIMEOUT_MS, (signal) =>
    lookupServerCacheUnbounded(settings, metadata, { ...context, signal }),
  );
}

async function lookupServerCacheUnbounded(
  settings: ExtensionSettings,
  metadata: CacheLookupRequest,
  context: BackendVerificationContext,
): Promise<{
  result: NormalizedProvenanceResult;
  cache: CacheMetadata;
} | null> {
  const token = settings.clientToken.trim();
  if (!token) {
    throw new ExtensionWorkflowError(
      "backend_configuration_missing",
      "Configure the backend client token before verifying an image.",
    );
  }

  let endpoint: URL;
  try {
    endpoint = parseBackendBaseUrl(settings.backendBaseUrl);
  } catch {
    throw new ExtensionWorkflowError(
      "backend_configuration_missing",
      "Configure a valid verification server URL in Settings.",
    );
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/u, "")}/api/cache/lookup`;
  endpoint.search = "";
  endpoint.hash = "";

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

  let response: Response;
  try {
    response = await (context.fetchImpl ?? fetch)(endpoint, requestInit);
  } catch (error: unknown) {
    if (isUserCancellation(context.signal)) {
      throw new ExtensionWorkflowError(
        "user_cancelled",
        "Verification cancelled by the user.",
      );
    }
    if (isAbortError(error)) {
      throw new ExtensionWorkflowError(
        "request_timeout",
        "The verification request was cancelled or timed out.",
        true,
      );
    }
    throw new ExtensionWorkflowError(
      "backend_unavailable",
      "The verification server is unavailable.",
      true,
    );
  }

  if (response.status === 404 || response.status === 405) {
    throw new ExtensionWorkflowError(
      "cache_unavailable",
      "The verification server does not provide the required cache endpoint.",
      true,
    );
  }

  const payload = await parseJsonResponse(response, context.signal);
  if (!response.ok) {
    const errorResponse = ServerErrorResponseSchema.safeParse(payload);
    if (!errorResponse.success) {
      throw new ExtensionWorkflowError(
        response.status >= 500 ? "backend_unavailable" : "cache_unavailable",
        "The verification cache returned an invalid error response.",
        response.status >= 500,
      );
    }
    const serverError = errorResponse.data.error;
    throw new ExtensionWorkflowError(
      serverError.code,
      serverError.message,
      serverError.retryable,
    );
  }

  const parsed = CacheLookupResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ExtensionWorkflowError(
      "cache_unavailable",
      "The verification cache returned an invalid response.",
      true,
    );
  }
  if (!parsed.data.hit) return null;
  if (
    parsed.data.verificationPolicyVersion !== IMAGE_VERIFICATION_POLICY_VERSION
  ) {
    // A different policy version is an intentional cache miss. The upload
    // endpoint will reject a server running an incompatible active policy.
    return null;
  }
  if (
    parsed.data.resultSchemaVersion !== IMAGE_RESULT_SCHEMA_VERSION ||
    !parsed.data.result.contentCredentials ||
    !isFreshExpiry(parsed.data.expiresAt)
  ) {
    return null;
  }
  const cache = CacheMetadataSchema.parse({
    source: "server_cache",
    originallyCheckedAt: parsed.data.originallyCheckedAt,
    expiresAt: parsed.data.expiresAt,
    verificationPolicyVersion: parsed.data.verificationPolicyVersion,
    resultSchemaVersion: parsed.data.resultSchemaVersion,
  });
  return { result: parsed.data.result, cache };
}

function isFreshExpiry(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

async function fetchWithRedirectChecks(
  initialUrl: URL,
  fetchImpl: typeof fetch,
  context: ImageRetrievalContext,
  pageOrigin?: string,
): Promise<Response> {
  let currentUrl = initialUrl;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    await assertHostPermission(
      currentUrl,
      pageOrigin,
      context.hasHostPermission,
    );
    const requestInit: RequestInit = {
      credentials: "omit",
      headers: { Accept: "image/png,image/jpeg,image/webp" },
      redirect: "manual",
    };
    if (context.signal) requestInit.signal = context.signal;
    let response: Response;
    try {
      response = await fetchImpl(currentUrl, requestInit);
    } catch (error: unknown) {
      if (isUserCancellation(context.signal)) {
        throw new ExtensionWorkflowError(
          "user_cancelled",
          "Verification cancelled by the user.",
        );
      }
      if (isAbortError(error)) {
        throw new ExtensionWorkflowError(
          "request_timeout",
          "Image retrieval was cancelled or timed out.",
          true,
        );
      }
      throw new ExtensionWorkflowError(
        "image_retrieval_failed",
        "The selected image could not be retrieved.",
      );
    }

    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location || redirect === MAX_REDIRECTS) {
      throw new ExtensionWorkflowError(
        "image_retrieval_failed",
        "The image redirect chain is invalid.",
      );
    }
    await response.body?.cancel();
    let nextUrl: URL;
    try {
      nextUrl = parseAllowedImageUrl(new URL(location, currentUrl).toString());
    } catch {
      throw new ExtensionWorkflowError(
        "image_retrieval_failed",
        "The image redirect target is not supported.",
      );
    }
    if (nextUrl.protocol === "blob:") {
      throw new ExtensionWorkflowError(
        "image_retrieval_failed",
        "The image redirect target is not retrievable.",
      );
    }
    currentUrl = nextUrl;
  }
  throw new ExtensionWorkflowError(
    "image_retrieval_failed",
    "The image redirect chain is too long.",
  );
}

async function assertHostPermission(
  url: URL,
  pageOrigin: string | undefined,
  hasHostPermission: ImageRetrievalContext["hasHostPermission"],
): Promise<void> {
  if (
    url.protocol !== "http:" &&
    url.protocol !== "https:" &&
    url.protocol !== "data:"
  ) {
    throw new ExtensionWorkflowError(
      "image_retrieval_failed",
      "This image URL scheme is not supported.",
    );
  }
  if (url.protocol === "data:") return;
  if (pageOrigin && url.origin === pageOrigin) return;
  if (!hasHostPermission || !(await hasHostPermission(url))) {
    throw new ExtensionWorkflowError(
      "permission_denied",
      "Permission is needed for this image host. Open Settings to grant access.",
    );
  }
}

async function readResponseBytes(
  response: Response,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  try {
    return await readBoundedResponseBytes(response, MAX_IMAGE_BYTES, signal);
  } catch (error) {
    if (signal?.aborted) throw abortErrorForSignal(signal);
    if (error instanceof ResponseBodyTooLargeError) {
      throw new ExtensionWorkflowError(
        "image_too_large",
        "The selected image is larger than 50 MiB.",
      );
    }
    throw error;
  }
}

async function parseJsonResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && isOversizedResponse(contentLength)) {
    throw new ExtensionWorkflowError(
      "invalid_api_response",
      "The verification server response is too large.",
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedResponseBytes(
      response,
      MAX_RESPONSE_BYTES,
      signal,
    );
  } catch (error: unknown) {
    if (signal?.aborted) throw abortErrorForSignal(signal);
    if (error instanceof ResponseBodyTooLargeError) {
      throw new ExtensionWorkflowError(
        "invalid_api_response",
        "The verification server response is too large.",
      );
    }
    if (error instanceof ExtensionWorkflowError) throw error;
    throw new ExtensionWorkflowError(
      "invalid_api_response",
      "The verification server response could not be read.",
    );
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ExtensionWorkflowError(
      "invalid_api_response",
      "The verification server returned invalid JSON.",
    );
  }
}

function decodeBase64(value: string): Uint8Array {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    throw new ExtensionWorkflowError(
      "image_retrieval_failed",
      "The selected inline image is invalid.",
    );
  }
  const binary = atob(value);
  if (binary.length > MAX_IMAGE_BYTES) {
    throw new ExtensionWorkflowError(
      "image_too_large",
      "The selected image is larger than 50 MiB.",
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function validateBytes(
  bytes: Uint8Array,
  declaredMime: string,
): SupportedImageMime {
  try {
    return validateImageBytes(bytes, declaredMime);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error) {
      const code = (error as Error & { code?: unknown }).code;
      if (code === "image_too_large" || code === "unsupported_image_type") {
        throw new ExtensionWorkflowError(code, error.message);
      }
    }
    throw new ExtensionWorkflowError(
      "unsupported_image_type",
      "Only PNG, JPEG, and WebP images are supported.",
    );
  }
}

function isOversizedContentLength(value: string): boolean {
  const size = Number(value);
  return !Number.isSafeInteger(size) || size < 0 || size > MAX_IMAGE_BYTES;
}

function isOversizedResponse(value: string): boolean {
  const size = Number(value);
  return !Number.isSafeInteger(size) || size < 0 || size > MAX_RESPONSE_BYTES;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function isUserCancellation(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && signal.reason === USER_CANCELLED_REASON;
}

async function withDeadline<T>(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectParent: ((reason?: unknown) => void) | undefined;
  const abortFromParent = (): void => {
    controller.abort(USER_CANCELLED_REASON);
    rejectParent?.(
      new ExtensionWorkflowError(
        "user_cancelled",
        "Verification cancelled by the user.",
      ),
    );
  };
  const parentPromise = parentSignal
    ? new Promise<never>((_, reject) => {
        rejectParent = reject;
        if (parentSignal.aborted) abortFromParent();
        else
          parentSignal.addEventListener("abort", abortFromParent, {
            once: true,
          });
      })
    : null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort(DEADLINE_REASON);
      reject(
        new ExtensionWorkflowError(
          "request_timeout",
          "The verification request timed out.",
          true,
        ),
      );
    }, timeoutMs);
  });
  const operationPromise = operation(controller.signal);
  try {
    return parentPromise
      ? await Promise.race([operationPromise, timeoutPromise, parentPromise])
      : await Promise.race([operationPromise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

function abortErrorForSignal(signal: AbortSignal): Error {
  if (signal.reason === USER_CANCELLED_REASON) {
    return new ExtensionWorkflowError(
      "user_cancelled",
      "Verification cancelled by the user.",
    );
  }
  if (signal.reason === DEADLINE_REASON) {
    return new ExtensionWorkflowError(
      "request_timeout",
      "The verification request timed out.",
      true,
    );
  }
  return new DOMException("The operation was aborted.", "AbortError");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function toWorkflowError(
  error: unknown,
  fallbackMessage: string,
  fallbackCode: ErrorCode,
): ExtensionWorkflowError {
  if (error instanceof ExtensionWorkflowError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new ExtensionWorkflowError(
      "user_cancelled",
      "Verification cancelled by the user.",
    );
  }
  return new ExtensionWorkflowError(fallbackCode, fallbackMessage);
}

function canOfferManualFallback(code: ErrorCode): boolean {
  return [
    "backend_unavailable",
    "backend_configuration_missing",
    "openai_api_key_missing",
    "openai_access_unavailable",
    "openai_rate_limit",
    "openai_server_error",
    "invalid_api_response",
    "request_timeout",
    "authentication_failed",
  ].includes(code);
}
