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
  "Grant optional download access from the popup or Settings before using Website mode.";

export const WEBSITE_OPEN_ERROR_MESSAGE =
  "The exact image was downloaded, but OpenAI Verify could not be opened. Open it manually to upload the file.";

export type WebsiteVerificationOutcome =
  | {
      kind: "website";
      status: "opened";
      message: typeof WEBSITE_HANDOFF_MESSAGE;
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
 * download, and open the official Verify page for a user-led upload.
 *
 * This function never sends a request to OpenAI and never injects, fills, or
 * reads the Verify page. The data URL is a reversible transport for the exact
 * validated bytes; it is not an image conversion or re-encoding operation.
 */
export async function verifySelectionOnWebsite(
  selection: ImageSelection,
  context: ImageRetrievalContext = {},
  browser: WebsiteBrowser = createChromeWebsiteBrowser(),
): Promise<WebsiteVerificationOutcome> {
  let image;
  try {
    image = await retrieveSelectedImage(selection, context);
  } catch (error: unknown) {
    return websiteError(
      error,
      "The selected image could not be retrieved for Website mode.",
      "image_retrieval_failed",
    );
  }

  if (context.signal?.aborted) {
    image.bytes.fill(0);
    return websiteCancelled();
  }

  try {
    await browser.download({
      url: `data:${image.mime};base64,${toBase64(image.bytes)}`,
      filename: image.filename,
      conflictAction: "uniquify",
      // Website mode is already initiated by the user's picker click. Save
      // directly to the browser's Downloads directory so Verify opens without
      // a second file chooser; uniquify prevents an existing file collision.
      saveAs: false,
    });
  } catch {
    image.bytes.fill(0);
    return {
      kind: "website",
      status: "error",
      errorCode: "permission_denied",
      message: WEBSITE_DOWNLOAD_PERMISSION_MESSAGE,
    };
  }

  image.bytes.fill(0);
  if (context.signal?.aborted) return websiteCancelled();
  try {
    await browser.createTab({ url: OPENAI_VERIFY_URL });
  } catch {
    return {
      kind: "website",
      status: "error",
      errorCode: "invalid_request",
      message: WEBSITE_OPEN_ERROR_MESSAGE,
    };
  }

  return {
    kind: "website",
    status: "opened",
    message: WEBSITE_HANDOFF_MESSAGE,
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
): WebsiteVerificationOutcome {
  if (error instanceof ExtensionWorkflowError) {
    if (error.code === "user_cancelled") return websiteCancelled();
    return {
      kind: "website",
      status: "error",
      errorCode: error.code,
      message: error.message,
    };
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return websiteCancelled();
  }
  return {
    kind: "website",
    status: "error",
    errorCode: fallbackCode,
    message: fallbackMessage,
  };
}

function websiteCancelled(): WebsiteVerificationOutcome {
  return {
    kind: "website",
    status: "cancelled",
    message: "Website verification was cancelled by the user.",
  };
}
