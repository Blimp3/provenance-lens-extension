import {
  OPENAI_VERIFY_URL,
  type ErrorCode,
  type ImageSelection,
} from "@provenance-lens/shared";

import {
  ExtensionWorkflowError,
  retrieveSelectedImage,
  type ImageRetrievalContext,
} from "./verify-openai-provenance.js";

/**
 * Website mode deliberately stops at the browser boundary. The downloaded
 * file is handed to the user, and the user uploads it on OpenAI Verify.
 * Nothing from that page is read back into the extension.
 */
export const WEBSITE_HANDOFF_MESSAGE =
  "The exact image was downloaded. Upload it to OpenAI Verify to review its supported provenance signals.";

export const WEBSITE_DOWNLOAD_PERMISSION_MESSAGE =
  "Grant optional download access in Settings before using Website mode.";

export const WEBSITE_OPEN_ERROR_MESSAGE =
  "The exact image was downloaded, but OpenAI Verify could not be opened. Open it manually to upload the file.";

/** Where a website handoff goes and what it tells the user. */
export interface WebsiteHandoffTarget {
  url: string;
  /** The workflow line after the site opened. */
  handoffMessage: string;
  /** The page toast's line under "Exact image saved". */
  toastMessage: string;
  retrievalErrorMessage: string;
  downloadPermissionMessage: string;
  openErrorMessage: string;
  cancelledMessage: string;
}

export const OPENAI_VERIFY_TARGET: WebsiteHandoffTarget = Object.freeze({
  url: OPENAI_VERIFY_URL,
  handoffMessage: WEBSITE_HANDOFF_MESSAGE,
  toastMessage:
    "Upload it to OpenAI Verify to review its supported provenance signals.",
  retrievalErrorMessage:
    "The selected image could not be retrieved for Website mode.",
  downloadPermissionMessage: WEBSITE_DOWNLOAD_PERMISSION_MESSAGE,
  openErrorMessage: WEBSITE_OPEN_ERROR_MESSAGE,
  cancelledMessage: "Website verification was cancelled by the user.",
});

export type WebsiteVerificationOutcome =
  | {
      kind: "website";
      status: "opened";
      message: string;
      toastMessage: string;
    }
  | {
      kind: "website";
      status: "cancelled";
      message: string;
    }
  | {
      kind: "website";
      status: "error";
      errorCode: ErrorCode;
      message: string;
    };

export interface WebsiteBrowser {
  download: (options: chrome.downloads.DownloadOptions) => Promise<number>;
  createTab: (
    options: chrome.tabs.CreateProperties,
  ) => Promise<chrome.tabs.Tab>;
}

/**
 * Retrieve the selected original bytes, save those bytes as a browser
 * download, and open the target site (OpenAI Verify unless another target is
 * given) for a user-led upload.
 *
 * This function never sends a request to the target and never injects,
 * fills, or reads its page. The data URL is a reversible transport for the
 * exact validated bytes; it is not an image conversion or re-encoding
 * operation.
 */
export async function verifySelectionOnWebsite(
  selection: ImageSelection,
  context: ImageRetrievalContext = {},
  browser: WebsiteBrowser = createChromeWebsiteBrowser(),
  target: WebsiteHandoffTarget = OPENAI_VERIFY_TARGET,
): Promise<WebsiteVerificationOutcome> {
  let image;
  try {
    image = await retrieveSelectedImage(selection, context);
  } catch (error: unknown) {
    return websiteError(
      error,
      target.retrievalErrorMessage,
      "image_retrieval_failed",
      target,
    );
  }

  if (context.signal?.aborted) {
    image.bytes.fill(0);
    return websiteCancelled(target);
  }

  try {
    await browser.download({
      url: `data:${image.mime};base64,${toBase64(image.bytes)}`,
      filename: image.filename,
      conflictAction: "uniquify",
      // The handoff is already initiated by the user's picker click. Save
      // directly to the browser's Downloads directory so the site opens
      // without a second file chooser; uniquify prevents a file collision.
      saveAs: false,
    });
  } catch {
    image.bytes.fill(0);
    return {
      kind: "website",
      status: "error",
      errorCode: "permission_denied",
      message: target.downloadPermissionMessage,
    };
  }

  image.bytes.fill(0);
  if (context.signal?.aborted) return websiteCancelled(target);
  try {
    await browser.createTab({ url: target.url });
  } catch {
    return {
      kind: "website",
      status: "error",
      errorCode: "invalid_request",
      message: target.openErrorMessage,
    };
  }

  return {
    kind: "website",
    status: "opened",
    message: target.handoffMessage,
    toastMessage: target.toastMessage,
  };
}

function createChromeWebsiteBrowser(): WebsiteBrowser {
  return {
    download: (options) => chrome.downloads.download(options),
    createTab: (options) => chrome.tabs.create(options),
  };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(index, Math.min(index + chunkSize, bytes.length)),
    );
  }
  return btoa(binary);
}

function websiteError(
  error: unknown,
  fallbackMessage: string,
  fallbackCode: ErrorCode,
  target: WebsiteHandoffTarget,
): WebsiteVerificationOutcome {
  if (error instanceof ExtensionWorkflowError) {
    if (error.code === "user_cancelled") return websiteCancelled(target);
    return {
      kind: "website",
      status: "error",
      errorCode: error.code,
      message: error.message,
    };
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return websiteCancelled(target);
  }
  return {
    kind: "website",
    status: "error",
    errorCode: fallbackCode,
    message: fallbackMessage,
  };
}

function websiteCancelled(
  target: WebsiteHandoffTarget,
): WebsiteVerificationOutcome {
  return {
    kind: "website",
    status: "cancelled",
    message: target.cancelledMessage,
  };
}
