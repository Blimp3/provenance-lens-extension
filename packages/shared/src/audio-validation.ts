import { fileTypeFromBuffer } from "file-type";
import { parseBlob, parseBuffer } from "music-metadata";

import { MAX_AUDIO_BYTES, MAX_AUDIO_DURATION_SECONDS } from "./constants.js";
import { normalizeMimeType } from "./file-validation.js";
import {
  SupportedAudioMimeSchema,
  type SupportedAudioMime,
} from "./schemas.js";

const FILE_TYPE_SAMPLE_BYTES = 4_100;

export interface ValidatedAudio {
  readonly mime: SupportedAudioMime;
  readonly durationSeconds: number;
}

export class AudioValidationError extends Error {
  public constructor(
    public readonly code:
      | "unsupported_audio_type"
      | "audio_too_large"
      | "audio_too_long"
      | "audio_duration_unknown",
    message: string,
  ) {
    super(message);
    this.name = "AudioValidationError";
  }
}

export async function validateAudioBytes(
  bytes: Uint8Array,
  declaredMime: string,
  maxBytes = MAX_AUDIO_BYTES,
): Promise<ValidatedAudio> {
  assertSize(bytes.byteLength, maxBytes);
  const declared = parseDeclaredMime(declaredMime);
  const detected = await detectAudioMime(bytes);
  if (detected === null || !audioMimeMatches(declared, detected)) {
    throw unsupportedAudio();
  }

  let metadata;
  try {
    metadata = await parseBuffer(bytes, detected, {
      duration: true,
      skipCovers: true,
    });
  } catch {
    throw unsupportedAudio();
  }
  return validateMetadata(metadata.format, declared);
}

export async function validateAudioBlob(
  blob: Blob,
  declaredMime = blob.type,
  maxBytes = MAX_AUDIO_BYTES,
): Promise<ValidatedAudio> {
  assertSize(blob.size, maxBytes);
  const declared = parseDeclaredMime(declaredMime);
  const sample = new Uint8Array(
    await blob.slice(0, FILE_TYPE_SAMPLE_BYTES).arrayBuffer(),
  );
  const detected = await detectAudioMime(sample);
  if (detected === null || !audioMimeMatches(declared, detected)) {
    throw unsupportedAudio();
  }

  let metadata;
  try {
    metadata = await parseBlob(blob, { duration: true, skipCovers: true });
  } catch {
    throw unsupportedAudio();
  }
  return validateMetadata(metadata.format, declared);
}

async function detectAudioMime(
  bytes: Uint8Array,
): Promise<SupportedAudioMime | null> {
  const fileType = await fileTypeFromBuffer(
    bytes.subarray(0, FILE_TYPE_SAMPLE_BYTES),
  );
  const parsed = SupportedAudioMimeSchema.safeParse(
    normalizeMimeType(fileType?.mime ?? ""),
  );
  return parsed.success ? parsed.data : null;
}

function parseDeclaredMime(value: string): SupportedAudioMime {
  const parsed = SupportedAudioMimeSchema.safeParse(normalizeMimeType(value));
  if (!parsed.success) throw unsupportedAudio();
  return parsed.data;
}

function canonicalMime(mime: SupportedAudioMime): SupportedAudioMime {
  if (mime === "audio/x-wav") return "audio/wav";
  if (mime === "audio/opus") return "audio/ogg";
  return mime;
}

function validateMetadata(
  format: {
    readonly codec?: string;
    readonly container?: string;
    readonly duration?: number;
  },
  declared: SupportedAudioMime,
): ValidatedAudio {
  if (
    (declared === "audio/opus" || declared === "audio/ogg") &&
    !isOpus(format.codec, format.container)
  ) {
    throw unsupportedAudio();
  }

  const duration = format.duration;
  if (duration === undefined || !Number.isFinite(duration) || duration <= 0) {
    throw new AudioValidationError(
      "audio_duration_unknown",
      "The audio duration could not be determined safely.",
    );
  }
  if (duration > MAX_AUDIO_DURATION_SECONDS) {
    throw new AudioValidationError(
      "audio_too_long",
      `Audio longer than ${MAX_AUDIO_DURATION_SECONDS} seconds is not supported.`,
    );
  }
  return { mime: canonicalMime(declared), durationSeconds: duration };
}

function audioMimeMatches(
  declared: SupportedAudioMime,
  detected: SupportedAudioMime,
): boolean {
  return canonicalMime(declared) === canonicalMime(detected);
}

function isOpus(
  codec: string | undefined,
  container: string | undefined,
): boolean {
  return `${codec ?? ""} ${container ?? ""}`.toLowerCase().includes("opus");
}

function assertSize(byteLength: number, maxBytes: number): void {
  if (byteLength > maxBytes) {
    throw new AudioValidationError(
      "audio_too_large",
      `The audio is larger than ${Math.floor(maxBytes / (1024 * 1024))} MiB.`,
    );
  }
}

function unsupportedAudio(): AudioValidationError {
  return new AudioValidationError(
    "unsupported_audio_type",
    "The audio type is unsupported or does not match the file contents.",
  );
}
