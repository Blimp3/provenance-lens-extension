import {
  DISCLOSURE_VERSION,
  MAX_AUDIO_BYTES,
  sha256Hex,
  type ExtensionSettings,
  type HistoryRecord,
} from "@provenance-lens/shared";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { RetrievedImage } from "../../src/actions/verify-openai-provenance.js";
import { API_MODE_REQUIRED_MESSAGE } from "../../src/api-verification-policy.js";

const mocks = vi.hoisted(() => ({
  createHistoryRecord: vi.fn(),
  getResult: vi.fn(),
  getSettings: vi.fn(),
  replaceHistoryRecord: vi.fn(),
  verifyRetrievedImage: vi.fn(),
}));

vi.mock("../../src/actions/verify-openai-provenance.js", () => ({
  createHistoryRecord: mocks.createHistoryRecord,
  verifyRetrievedImage: mocks.verifyRetrievedImage,
}));

vi.mock("../../src/storage.js", () => ({
  getResult: mocks.getResult,
  getSettings: mocks.getSettings,
  replaceHistoryRecord: mocks.replaceHistoryRecord,
}));

const record: HistoryRecord = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  actionId: "verify-openai-provenance",
  createdAt: "2026-09-01T10:00:00.000Z",
  sourceHostname: "page.example",
  pageTitle: "Fixture",
  inputKind: "original_file",
  imageSha256: null,
  result: {
    verdict: "openai_signal_detected",
    summary: "Detected signals: SynthID.",
    signals: [
      {
        type: "synthid",
        outcome: "detected",
        validationState: null,
        issuer: null,
        model: null,
        generatedAt: null,
      },
    ],
    warnings: [],
    checkedAt: "2026-09-01T10:00:00.000Z",
    requestId: "123e4567-e89b-42d3-a456-426614174000",
  },
  cache: null,
  errorCode: null,
  manualFallbackAvailable: false,
  screenshotFallbackAvailable: false,
};

const apiSettings: ExtensionSettings = {
  verificationMode: "api",
  acknowledgedVerificationModes: ["api"],
  backendBaseUrl: "https://verify.example",
  clientToken: "client-token",
  historyRetention: 20,
  screenshotFallbackEnabled: false,
  includePageTitle: true,
  debugMode: false,
  localCacheLimit: 100,
  disclosureVersion: DISCLOSURE_VERSION,
};

let recheckCachedResult: (
  record: HistoryRecord,
  file: File,
  button: HTMLButtonElement,
) => Promise<void>;

describe("cached-result API recheck", () => {
  beforeAll(async () => {
    document.body.innerHTML =
      '<main id="details-content"></main><p id="details-status"></p>';
    history.replaceState(null, "", `?id=${record.id}`);
    mocks.getResult.mockResolvedValue(record);
    mocks.getSettings.mockResolvedValue(apiSettings);
    ({ recheckCachedResult } = await import("../../src/ui/details.js"));
    await Promise.resolve();
  });

  beforeEach(() => {
    mocks.getSettings.mockReset();
    mocks.getSettings.mockResolvedValue(apiSettings);
    mocks.createHistoryRecord.mockReset();
    mocks.replaceHistoryRecord.mockReset();
    mocks.verifyRetrievedImage.mockReset();
    const status = document.getElementById("details-status");
    if (status) {
      status.textContent = "";
      status.className = "";
    }
  });

  it("shows a detected SynthID outcome without C2PA-only or empty metadata rows", () => {
    const text = document.getElementById("details-content")?.textContent ?? "";
    expect(text).toContain("SynthIDDetected");
    expect(text).toContain(
      "The API reported this SynthID outcome without model or generation-time metadata.",
    );
    expect(text).not.toContain("Validation state");
    expect(text).not.toContain("Issuer");
    expect(text).not.toContain("Not available");
  });

  it.each([
    {
      verificationMode: "website" as const,
      acknowledgedVerificationModes: ["website"] as const,
    },
    {
      verificationMode: "api" as const,
      acknowledgedVerificationModes: [] as const,
    },
  ])(
    "fails closed before reading file bytes without API authorization",
    async (mode) => {
      mocks.getSettings.mockResolvedValue({ ...apiSettings, ...mode });
      const file = pngFile();
      const arrayBuffer = vi.spyOn(file, "arrayBuffer");
      const button = document.createElement("button");

      await recheckCachedResult(
        { ...record, imageSha256: "0".repeat(64) },
        file,
        button,
      );

      expect(arrayBuffer).not.toHaveBeenCalled();
      expect(mocks.verifyRetrievedImage).not.toHaveBeenCalled();
      expect(document.getElementById("details-status")?.textContent).toBe(
        API_MODE_REQUIRED_MESSAGE,
      );
      expect(button.disabled).toBe(false);
    },
  );

  it("rejects oversized audio rechecks before allocating file bytes", async () => {
    const file = pngFile();
    Object.defineProperty(file, "size", { value: MAX_AUDIO_BYTES + 1 });
    const arrayBuffer = vi.spyOn(file, "arrayBuffer");
    const button = document.createElement("button");

    await recheckCachedResult(
      {
        ...record,
        actionId: "verify-openai-audio",
        mediaKind: "audio",
        imageSha256: "0".repeat(64),
      },
      file,
      button,
    );

    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(document.getElementById("details-status")?.textContent).toBe(
      "The selected file is larger than 4 MiB or empty.",
    );
    expect(button.disabled).toBe(false);
  });

  it("preserves acknowledged API recheck behavior and clears exact bytes", async () => {
    const original = pngBytes();
    const buffer = original.buffer.slice(0) as ArrayBuffer;
    const file = pngFile();
    vi.spyOn(file, "arrayBuffer").mockResolvedValue(buffer);
    mocks.verifyRetrievedImage.mockImplementation((image: RetrievedImage) => {
      expect(Array.from(image.bytes)).toEqual(Array.from(original));
      return Promise.resolve({
        result: {
          ...record.result,
          verdict: "indeterminate",
          summary: "The backend is unavailable.",
        },
        imageSha256: record.imageSha256,
        cache: null,
        errorCode: "backend_unavailable",
        retrieved: null,
        manualFallbackAvailable: false,
        screenshotFallbackAvailable: false,
      });
    });
    const button = document.createElement("button");

    await recheckCachedResult(
      { ...record, imageSha256: await sha256Hex(original) },
      file,
      button,
    );

    expect(mocks.verifyRetrievedImage).toHaveBeenCalledOnce();
    expect(new Uint8Array(buffer).every((byte) => byte === 0)).toBe(true);
    expect(button.disabled).toBe(false);
  });

  it("clears exact bytes when the selected file hash does not match", async () => {
    const buffer = pngBytes().buffer.slice(0) as ArrayBuffer;
    const file = pngFile();
    vi.spyOn(file, "arrayBuffer").mockResolvedValue(buffer);

    await recheckCachedResult(
      { ...record, imageSha256: "0".repeat(64) },
      file,
      document.createElement("button"),
    );

    expect(mocks.verifyRetrievedImage).not.toHaveBeenCalled();
    expect(new Uint8Array(buffer).every((byte) => byte === 0)).toBe(true);
  });

  it("atomically replaces a cached record and refuses a deleted record", async () => {
    const original = pngBytes();
    const firstBuffer = original.buffer.slice(0) as ArrayBuffer;
    const firstFile = pngFile();
    vi.spyOn(firstFile, "arrayBuffer").mockResolvedValue(firstBuffer);
    const replacement: HistoryRecord = {
      ...record,
      result: { ...record.result, summary: "The rechecked result." },
    };
    mocks.createHistoryRecord.mockReturnValue(replacement);
    mocks.verifyRetrievedImage.mockResolvedValue({
      result: replacement.result,
      imageSha256: await sha256Hex(original),
      cache: record.cache,
      errorCode: null,
      retrieved: null,
      manualFallbackAvailable: false,
      screenshotFallbackAvailable: false,
    });
    mocks.replaceHistoryRecord.mockResolvedValueOnce(true);

    const firstButton = document.createElement("button");
    await recheckCachedResult(
      { ...record, imageSha256: await sha256Hex(original) },
      firstFile,
      firstButton,
    );

    expect(mocks.replaceHistoryRecord).toHaveBeenCalledWith(
      expect.objectContaining({ id: record.id, result: replacement.result }),
    );
    expect(document.getElementById("details-status")?.textContent).toBe(
      "Recheck completed and the cached result was replaced.",
    );
    expect(firstButton.disabled).toBe(false);

    const secondOriginal = pngBytes();
    const secondBuffer = secondOriginal.buffer.slice(0) as ArrayBuffer;
    const secondFile = pngFile();
    vi.spyOn(secondFile, "arrayBuffer").mockResolvedValue(secondBuffer);
    mocks.replaceHistoryRecord.mockResolvedValueOnce(false);

    const secondButton = document.createElement("button");
    await recheckCachedResult(
      { ...record, imageSha256: await sha256Hex(secondOriginal) },
      secondFile,
      secondButton,
    );

    expect(document.getElementById("details-status")?.textContent).toBe(
      "This result is no longer in history.",
    );
    expect(secondButton.disabled).toBe(false);
    expect(new Uint8Array(firstBuffer).every((byte) => byte === 0)).toBe(true);
    expect(new Uint8Array(secondBuffer).every((byte) => byte === 0)).toBe(true);
  });
});

function pngBytes(): Uint8Array {
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
}

function pngFile(): File {
  const bytes = pngBytes();
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new File([buffer], "image.png", { type: "image/png" });
}
