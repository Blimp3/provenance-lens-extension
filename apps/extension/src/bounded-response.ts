export class ResponseBodyTooLargeError extends Error {
  public constructor() {
    super("The response body exceeds the permitted size.");
    this.name = "ResponseBodyTooLargeError";
  }
}

export async function readBoundedResponseBytes(
  response: Response,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new TypeError("The response byte limit must be a positive integer.");
  }

  const contentLength = response.headers.get("content-length")?.trim();
  if (contentLength && /^\d+$/u.test(contentLength)) {
    const declaredLength = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength > maximumBytes
    ) {
      throw new ResponseBodyTooLargeError();
    }
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("The response body is unavailable.");
  const abort = (): void => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      if (signal?.aborted) throw abortError(signal);
      const { done, value } = await reader.read();
      if (signal?.aborted) throw abortError(signal);
      if (done) break;
      if (value.byteLength > maximumBytes - totalBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseBodyTooLargeError();
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }

    const bytes = new Uint8Array(new ArrayBuffer(totalBytes));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    signal?.removeEventListener("abort", abort);
    for (const chunk of chunks) chunk.fill(0);
    reader.releaseLock();
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}
