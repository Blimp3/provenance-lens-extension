import { MAX_IMAGE_BYTES, MAX_INLINE_IMAGE_BYTES } from "./constants.js";
import {
  SupportedImageMimeSchema,
  type SupportedImageMime,
  type SupportedAudioMime,
} from "./schemas.js";

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

export class ImageValidationError extends Error {
  public constructor(
    public readonly code: "unsupported_image_type" | "image_too_large",
    message: string,
  ) {
    super(message);
    this.name = "ImageValidationError";
  }
}

export function normalizeMimeType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function detectImageMime(bytes: Uint8Array): SupportedImageMime | null {
  if (
    bytes.length >= PNG_SIGNATURE.length &&
    PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
  ) {
    return "image/png";
  }

  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  return null;
}

export function validateImageBytes(
  bytes: Uint8Array,
  declaredMime: string,
  maxBytes = MAX_IMAGE_BYTES,
): SupportedImageMime {
  if (bytes.byteLength > maxBytes) {
    throw new ImageValidationError(
      "image_too_large",
      `The image is larger than ${Math.floor(maxBytes / (1024 * 1024))} MiB.`,
    );
  }

  const parsedMime = SupportedImageMimeSchema.safeParse(
    normalizeMimeType(declaredMime),
  );
  if (!parsedMime.success) {
    throw new ImageValidationError(
      "unsupported_image_type",
      "Only PNG, JPEG, and WebP images are supported.",
    );
  }

  const detectedMime = detectImageMime(bytes);
  if (detectedMime === null || detectedMime !== parsedMime.data) {
    throw new ImageValidationError(
      "unsupported_image_type",
      "The image type does not match the file contents.",
    );
  }

  return detectedMime;
}

export function validateInlineImageSize(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_INLINE_IMAGE_BYTES) {
    throw new ImageValidationError(
      "image_too_large",
      "This data or blob image is too large to transfer safely. Download the original file and verify it manually.",
    );
  }
}

export function extensionForMime(
  mime: SupportedImageMime,
): "png" | "jpg" | "webp" {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  return "webp";
}

export function extensionForAudioMime(
  mime: SupportedAudioMime,
): "mp3" | "ogg" | "aac" | "flac" | "wav" {
  if (mime === "audio/mpeg") return "mp3";
  if (mime === "audio/aac") return "aac";
  if (mime === "audio/flac") return "flac";
  if (mime === "audio/wav" || mime === "audio/x-wav") return "wav";
  return "ogg";
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}
