export class ScreenshotTooLargeError extends Error {
  public constructor() {
    super("The screenshot copy exceeds the permitted size.");
    this.name = "ScreenshotTooLargeError";
  }
}

export function assertScreenshotPixelBudget(
  viewportWidth: number,
  viewportHeight: number,
  devicePixelRatio: number,
  maximumRawBytes: number,
): void {
  const pixelWidth = Math.ceil(viewportWidth * devicePixelRatio);
  const pixelHeight = Math.ceil(viewportHeight * devicePixelRatio);
  if (
    !Number.isSafeInteger(pixelWidth) ||
    !Number.isSafeInteger(pixelHeight) ||
    pixelWidth <= 0 ||
    pixelHeight <= 0 ||
    pixelWidth > Math.floor(maximumRawBytes / 4 / pixelHeight)
  ) {
    throw new ScreenshotTooLargeError();
  }
}

export function assertScreenshotDataUrlBudget(
  dataUrl: string,
  maximumDecodedBytes: number,
): void {
  const commaIndex = dataUrl.indexOf(",");
  if (
    commaIndex < 0 ||
    !dataUrl.slice(0, commaIndex).toLowerCase().endsWith(";base64")
  ) {
    throw new Error("The browser returned an invalid screenshot copy.");
  }
  const encodedLength = dataUrl.length - commaIndex - 1;
  const padding = dataUrl.endsWith("==") ? 2 : dataUrl.endsWith("=") ? 1 : 0;
  const decodedLength = Math.floor((encodedLength * 3) / 4) - padding;
  if (
    !Number.isSafeInteger(decodedLength) ||
    decodedLength < 0 ||
    decodedLength > maximumDecodedBytes
  ) {
    throw new ScreenshotTooLargeError();
  }
}
