import { readFile } from "node:fs/promises";

import {
  AudioValidationError,
  validateAudioBlob,
  validateAudioBytes,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

const vorbis = new Uint8Array(
  await readFile(new URL("./fixtures/audio-vorbis.ogg", import.meta.url)),
);
const opus = new Uint8Array(
  await readFile(new URL("./fixtures/audio-opus.ogg", import.meta.url)),
);

describe("audio byte validation", () => {
  it("accepts Ogg Opus using the documented audio/ogg upload type", async () => {
    await expect(validateAudioBytes(opus, "audio/ogg")).resolves.toMatchObject({
      mime: "audio/ogg",
    });
    await expect(
      validateAudioBlob(new Blob([opus], { type: "audio/ogg" })),
    ).resolves.toMatchObject({ mime: "audio/ogg" });
  });

  it("normalizes the audio/opus alias to the documented audio/ogg upload type", async () => {
    await expect(validateAudioBytes(opus, "audio/opus")).resolves.toMatchObject(
      { mime: "audio/ogg" },
    );
  });

  it.each(["audio/opus", "audio/ogg"])(
    "rejects unsupported Vorbis declared as %s",
    async (mime) => {
      await expect(validateAudioBytes(vorbis, mime)).rejects.toMatchObject({
        code: "unsupported_audio_type",
      });
      await expect(
        validateAudioBlob(new Blob([vorbis], { type: mime })),
      ).rejects.toMatchObject({ code: "unsupported_audio_type" });
    },
  );

  it.each([
    new Uint8Array(),
    new Uint8Array([0x52, 0x49, 0x46, 0x46]),
    new Uint8Array([0x4f, 0x67, 0x67, 0x53]),
  ])("rejects malformed or truncated audio bytes", async (bytes) => {
    await expect(validateAudioBytes(bytes, "audio/wav")).rejects.toBeInstanceOf(
      AudioValidationError,
    );
  });

  it("rejects a declared MIME that does not match file detection", async () => {
    await expect(
      validateAudioBytes(vorbis, "audio/mpeg"),
    ).rejects.toMatchObject({ code: "unsupported_audio_type" });
  });
});
