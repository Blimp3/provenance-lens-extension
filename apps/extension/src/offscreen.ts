import {
  OFFSCREEN_TARGET,
  WORKER_PATH,
  type OffscreenCopyMessage,
} from "./offscreen-copy.js";

/**
 * The worker's offscreen document. It cannot take focus, so it copies with a
 * selected textarea and execCommand("copy") rather than navigator.clipboard,
 * and only for the worker's own messages. Its only extension API is runtime
 * messaging, so it tells the worker apart by what the sender is: the
 * worker's own script, outside any tab. The worker copies only the pending
 * pairing's /link command.
 */

const field = document.getElementById("copy");
const workerUrl = new URL(WORKER_PATH, location.origin).href;

chrome.runtime.onMessage.addListener(
  (message: unknown, sender, sendResponse) => {
    if (
      sender.tab !== undefined ||
      sender.url !== workerUrl ||
      typeof message !== "object" ||
      message === null
    )
      return false;
    const { target, type, text } = message as Partial<OffscreenCopyMessage>;
    if (target !== OFFSCREEN_TARGET || type !== "copy") return false;
    sendResponse(copy(text));
    return false;
  },
);

function copy(text: unknown): boolean {
  if (
    !(field instanceof HTMLTextAreaElement) ||
    typeof text !== "string" ||
    text.length === 0
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
