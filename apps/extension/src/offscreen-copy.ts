/**
 * The worker's clipboard: one offscreen document, created at the first copy
 * and reused, copies text for a palette frame inside a page, whose own
 * Clipboard API the page's Permissions Policy can block.
 */

const OFFSCREEN_PATH = "offscreen.html";
/** The worker's script, as the manifest names it: the only sender it copies for. */
export const WORKER_PATH = "background.js";
/** Marks the worker's messages to the offscreen document. */
export const OFFSCREEN_TARGET = "lens-offscreen";

export type OffscreenCopyMessage = {
  target: typeof OFFSCREEN_TARGET;
  type: "copy";
  text: string;
};

let ready: Promise<void> | null = null;

/** Copies the text through the offscreen document; true once it is copied. */
export async function copyThroughOffscreen(text: string): Promise<boolean> {
  try {
    ready ??= openOffscreenDocument();
    await ready;
    const message: OffscreenCopyMessage = {
      target: OFFSCREEN_TARGET,
      type: "copy",
      text,
    };
    return (await chrome.runtime.sendMessage(message)) === true;
  } catch {
    // A document that failed to open or closed is opened again next time.
    ready = null;
    return false;
  }
}

/** A restarted worker finds the document it opened before and reuses it. */
async function openOffscreenDocument(): Promise<void> {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url],
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["CLIPBOARD"],
    justification:
      "Copy the DigiBot /link command for the Lens palette when the page blocks the Clipboard API.",
  });
}
