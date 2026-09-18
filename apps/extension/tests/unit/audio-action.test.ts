import {
  RESULT_SCHEMA_VERSION,
  VERIFICATION_POLICY_VERSION,
  type CacheMetadata,
  type ExtensionSettings,
  type NormalizedProvenanceResult,
} from "@provenance-lens/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { findLocalCache, saveLocalCache } from "../../src/cache.js";
import { verifyAudioFile } from "../../src/actions/verify-openai-audio.js";

vi.mock("../../src/cache.js", () => ({
  findLocalCache: vi.fn(),
  isCacheableResult: (value: NormalizedProvenanceResult) =>
    value.verdict === "openai_signal_detected" ||
    value.verdict === "no_supported_openai_signal",
  saveLocalCache: vi.fn(),
}));

const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const settings: ExtensionSettings = {
  verificationMode: "api",
  acknowledgedVerificationModes: ["api"],
  backendBaseUrl: "https://verify.example",
  clientToken: "client-token",
  historyRetention: 20,
  screenshotFallbackEnabled: false,
  includePageTitle: true,
  debugMode: false,
  localCacheLimit: 100,
  disclosureVersion: 2,
};

function audioFile(): File {
  const sampleRate = 8_000;
  const sampleCount = sampleRate;
  const dataSize = sampleCount * 2;
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

function result(
  signal: "synthid" | "c2pa" = "synthid",
): NormalizedProvenanceResult {
  return {
    verdict: "openai_signal_detected",
    summary: "Detected signals: SynthID.",
    signals: [
      signal === "synthid"
        ? {
            type: "synthid",
            outcome: "detected",
            validationState: null,
            issuer: null,
            model: null,
            generatedAt: null,
          }
        : {
            type: "c2pa",
            outcome: "detected",
            validationState: "trusted",
            issuer: "OpenAI OpCo, LLC",
            model: "gpt-image",
            generatedAt: null,
          },
    ],
    warnings: [],
    checkedAt: "2026-09-01T10:00:00.000Z",
    requestId: REQUEST_ID,
  };
}

function resultWithCredentials(): NormalizedProvenanceResult {
  return {
    ...result(),
    contentCredentials: {
      status: "verified",
      signatureValid: true,
      contentBindingValid: true,
      signerTrusted: false,
      issuer: "Test signer",
      actions: [],
      aiDeclaration: null,
      validationCodes: [],
      trustListVersion: "test-trust-list",
    },
  };
}

function cache(source: CacheMetadata["source"]): CacheMetadata {
  return {
    source,
    originallyCheckedAt: "2026-09-01T10:00:00.000Z",
    expiresAt: "2099-09-01T10:00:00.000Z",
    verificationPolicyVersion: VERIFICATION_POLICY_VERSION,
    resultSchemaVersion: RESULT_SCHEMA_VERSION,
  };
}

function response(value: NormalizedProvenanceResult): Response {
  return new Response(
    JSON.stringify({ result: value, cache: cache("fresh") }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function cacheMiss(): Response {
  return new Response(
    JSON.stringify({
      hit: false,
      verificationPolicyVersion: VERIFICATION_POLICY_VERSION,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function cacheHit(value: NormalizedProvenanceResult): Response {
  const metadata = cache("server_cache");
  return new Response(
    JSON.stringify({
      hit: true,
      result: value,
      originallyCheckedAt: metadata.originallyCheckedAt,
      expiresAt: metadata.expiresAt,
      verificationPolicyVersion: metadata.verificationPolicyVersion,
      resultSchemaVersion: metadata.resultSchemaVersion,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

describe("audio verification action", () => {
  beforeEach(() => {
    vi.mocked(findLocalCache).mockReset();
    vi.mocked(saveLocalCache).mockReset();
    vi.mocked(findLocalCache).mockResolvedValue(null);
    vi.mocked(saveLocalCache).mockResolvedValue(undefined);
  });

  it("uploads exact original bytes for a valid SynthID result", async () => {
    const file = audioFile();
    const fetchImpl = vi.fn<typeof fetch>((input) =>
      Promise.resolve(
        requestUrl(input).includes("/cache/lookup")
          ? cacheMiss()
          : response(result()),
      ),
    );

    const outcome = await verifyAudioFile(file, settings, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(outcome.result).toEqual(result());
    expect(outcome.errorCode).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(vi.mocked(saveLocalCache)).toHaveBeenCalledTimes(1);
    const upload = fetchImpl.mock.calls[1]?.[1]?.body as FormData;
    const uploaded = upload.get("file");
    expect(uploaded).toBeInstanceOf(File);
    expect(new Uint8Array(await (uploaded as File).arrayBuffer())).toEqual(
      new Uint8Array(await file.arrayBuffer()),
    );
  });

  it.each([
    ["local cache", result("c2pa"), "local_cache" as const],
    [
      "local cache credentials",
      resultWithCredentials(),
      "local_cache" as const,
    ],
  ])("rejects %s evidence", async (_label, invalid, source) => {
    vi.mocked(findLocalCache).mockResolvedValue({
      result: invalid,
      cache: cache(source),
    });
    const fetchImpl = vi.fn();

    const outcome = await verifyAudioFile(audioFile(), settings, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(outcome.errorCode).toBe("invalid_api_response");
    expect(outcome.result.verdict).toBe("indeterminate");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([result("c2pa"), resultWithCredentials()])(
    "rejects unsupported evidence in a server cache hit",
    async (invalid) => {
      const fetchImpl = vi.fn((input: RequestInfo | URL) =>
        Promise.resolve(
          requestUrl(input).includes("/cache/lookup")
            ? cacheHit(invalid)
            : response(result()),
        ),
      );

      const outcome = await verifyAudioFile(audioFile(), settings, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(outcome.errorCode).toBe("invalid_api_response");
      expect(outcome.result.verdict).toBe("indeterminate");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(vi.mocked(saveLocalCache)).not.toHaveBeenCalled();
    },
  );

  it.each([result("c2pa"), resultWithCredentials()])(
    "rejects unsupported evidence in an upload response",
    async (invalid) => {
      const fetchImpl = vi.fn((input: RequestInfo | URL) =>
        Promise.resolve(
          requestUrl(input).includes("/cache/lookup")
            ? cacheMiss()
            : response(invalid),
        ),
      );

      const outcome = await verifyAudioFile(audioFile(), settings, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(outcome.errorCode).toBe("invalid_api_response");
      expect(outcome.result.verdict).toBe("indeterminate");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(vi.mocked(saveLocalCache)).not.toHaveBeenCalled();
    },
  );

  it("does not validate or upload when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn();
    const file = new File([new Uint8Array([1, 2, 3])], "bad.wav", {
      type: "audio/wav",
    });

    const outcome = await verifyAudioFile(file, settings, {
      signal: controller.signal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(outcome.errorCode).toBe("user_cancelled");
    expect(outcome.result.verdict).toBe("indeterminate");
    expect(findLocalCache).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
