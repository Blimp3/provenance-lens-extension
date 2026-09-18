import {
  AudioValidationError,
  validateAudioBlob,
  validateAudioBytes,
} from "../src/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const metadataMock = vi.hoisted(() => ({
  parseBlob: vi.fn(),
  parseBuffer: vi.fn(),
}));

vi.mock("music-metadata", () => metadataMock);

const WAV = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66,
  0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x40, 0x1f,
  0x00, 0x00, 0x80, 0x3e, 0x00, 0x00, 0x02, 0x00, 0x10, 0x00, 0x64, 0x61, 0x74,
  0x61, 0x00, 0x00, 0x00, 0x00,
]);

describe("audio metadata validation", () => {
  beforeEach(() => {
    metadataMock.parseBlob.mockReset();
    metadataMock.parseBuffer.mockReset();
    metadataMock.parseBlob.mockResolvedValue({
      format: { codec: "PCM", container: "WAV", duration: 1 },
    });
    metadataMock.parseBuffer.mockResolvedValue({
      format: { codec: "PCM", container: "WAV", duration: 1 },
    });
  });

  it.each([undefined, 0, NaN, Infinity, -1])(
    "fails closed when duration is %s",
    async (duration) => {
      metadataMock.parseBuffer.mockResolvedValue({
        format: { codec: "PCM", container: "WAV", duration },
      });

      await expect(validateAudioBytes(WAV, "audio/wav")).rejects.toMatchObject({
        code: "audio_duration_unknown",
      });
    },
  );

  it("accepts exactly 60 seconds and rejects longer audio", async () => {
    metadataMock.parseBuffer.mockResolvedValue({
      format: { codec: "PCM", container: "WAV", duration: 60 },
    });
    await expect(validateAudioBytes(WAV, "audio/wav")).resolves.toMatchObject({
      durationSeconds: 60,
    });

    metadataMock.parseBuffer.mockResolvedValue({
      format: { codec: "PCM", container: "WAV", duration: 60.001 },
    });
    await expect(validateAudioBytes(WAV, "audio/wav")).rejects.toMatchObject({
      code: "audio_too_long",
    });
  });

  it("accepts the size boundary and rejects one byte over it", async () => {
    await expect(
      validateAudioBytes(WAV, "audio/wav", WAV.byteLength),
    ).resolves.toMatchObject({ mime: "audio/wav" });
    await expect(
      validateAudioBytes(WAV, "audio/wav", WAV.byteLength - 1),
    ).rejects.toMatchObject({ code: "audio_too_large" });
  });

  it("asks music-metadata to skip embedded covers", async () => {
    await validateAudioBlob(new Blob([WAV], { type: "audio/wav" }));
    expect(metadataMock.parseBlob).toHaveBeenCalledWith(expect.any(Blob), {
      duration: true,
      skipCovers: true,
    });
  });

  it("maps metadata parser failures to an unsupported audio error", async () => {
    metadataMock.parseBuffer.mockRejectedValue(new Error("malformed"));
    await expect(validateAudioBytes(WAV, "audio/wav")).rejects.toBeInstanceOf(
      AudioValidationError,
    );
  });
});
