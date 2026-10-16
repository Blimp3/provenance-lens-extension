import { COPY_TEXT_MAX_LENGTH } from "@provenance-lens/shared";

import { OFFSCREEN_TARGET } from "./offscreen-copy.js";

/**
 * The worker's offscreen document. It cannot take focus, so it copies with a
 * selected textarea and execCommand("copy") rather than navigator.clipboard,
 * and only for the worker's own messages. Its only extension API is runtime
 * messaging, so it tells the worker apart by what the sender is: every other
 * Lens context, a palette frame inside a page included, lives in a tab.
 */

const field = document.getElementById("copy");

chrome.runtime.onMessage.addListener(
  (message: unknown, sender, sendResponse) => {
    if (
      sender.tab !== undefined ||
      URL.parse(sender.url ?? "")?.origin !== location.origin ||
      typeof message !== "object" ||
      message === null
    )
      return false;
    const { target, type, text } = message as Record<string, unknown>;
    if (target !== OFFSCREEN_TARGET || type !== "copy") return false;
    sendResponse(copy(text));
    return false;
  },
);

function copy(text: unknown): boolean {
  if (
    !(field instanceof HTMLTextAreaElement) ||
    typeof text !== "string" ||
    text.length === 0 ||
    text.length > COPY_TEXT_MAX_LENGTH
  )
    return false;
  field.value = text;
  field.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.value = "";
  }
}
