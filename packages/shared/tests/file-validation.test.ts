import {
  ImageValidationError,
  MAX_IMAGE_BYTES,
  detectImageMime,
  validateImageBytes,
} from "../src/index.js";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const jpeg = new Uint8Array([255, 216, 255, 224, 0]);
const webp = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80, 0]);

describe("image byte validation", () => {
  it.each([
    [png, "image/png"],
    [jpeg, "image/jpeg"],
    [webp, "image/webp"],
  ] as const)("recognizes supported magic bytes", (bytes, expected) => {
    expect(detectImageMime(bytes)).toBe(expected);
    expect(validateImageBytes(bytes, expected)).toBe(expected);
  });

  it("rejects HTML served with an image MIME type", () => {
    const html = new TextEncoder().encode("<!doctype html><title>no</title>");
    expect(() => validateImageBytes(html, "image/png")).toThrow(
      ImageValidationError,
    );
  });

  it("rejects a MIME and magic-byte mismatch", () => {
    expect(() => validateImageBytes(png, "image/jpeg")).toThrow(
      "does not match",
    );
  });

  it("rejects unsupported formats", () => {
    expect(() =>
      validateImageBytes(new Uint8Array([71, 73, 70]), "image/gif"),
    ).toThrow("Only PNG");
  });

  it("rejects files larger than 50 MiB", () => {
    const oversized = new Uint8Array(MAX_IMAGE_BYTES + 1);
    expect(() => validateImageBytes(oversized, "image/png")).toThrow(
      "larger than 50 MiB",
    );
  });
});
