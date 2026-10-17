import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { WORKER_PATH } from "../../src/offscreen-copy.js";

type Receiver = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => unknown;

const COPY = { target: "lens-offscreen", type: "copy", text: "/link 7F3K9Q" };

describe("the offscreen document", () => {
  let receive: Receiver;
  let copied: string[];
  const workerUrl = (): string => `${location.origin}/background.js`;

  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = `<textarea id="copy"></textarea>`;
    copied = [];
    const field = document.getElementById("copy") as HTMLTextAreaElement;
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => {
        copied.push(field.value);
        return true;
      }),
    });
    vi.stubGlobal("chrome", {
      runtime: {
        onMessage: {
          addListener: (listener: Receiver) => {
            receive = listener;
          },
        },
      },
    });
    await import("../../src/offscreen.js");
  });

  function answer(message: unknown, sender: chrome.runtime.MessageSender) {
    const respond = vi.fn();
    receive(message, sender, respond);
    return respond.mock.calls[0]?.[0] as unknown;
  }

  it("copies the worker's message and clears the field", () => {
    expect(answer(COPY, { url: workerUrl() })).toBe(true);
    expect(copied).toEqual(["/link 7F3K9Q"]);
    expect((document.getElementById("copy") as HTMLTextAreaElement).value).toBe(
      "",
    );
  });

  it("copies nothing for any sender but the worker's own script", () => {
    for (const sender of [
      // A Lens page in a tab, a palette frame inside a page included.
      { url: workerUrl(), tab: { id: 7 } as chrome.tabs.Tab },
      // The fallback popup and other tab-less Lens contexts.
      { url: `${location.origin}/palette.html#t=frame` },
      { url: `${location.origin}/offscreen.html` },
      // Another extension's worker, or no address at all.
      { url: "chrome-extension://other/background.js" },
      {},
    ])
      expect(answer(COPY, sender)).toBeUndefined();
    for (const message of [
      { ...COPY, target: "other" },
      { ...COPY, type: "paste" },
      null,
      "copy",
    ])
      expect(answer(message, { url: workerUrl() })).toBeUndefined();
    for (const text of [42, ""])
      expect(answer({ ...COPY, text }, { url: workerUrl() })).toBe(false);
    expect(copied).toEqual([]);
  });

  it("knows the worker by the script the manifest names", async () => {
    const manifest = JSON.parse(
      await readFile(
        resolve(import.meta.dirname, "../../manifest.json"),
        "utf8",
      ),
    ) as { background: { service_worker: string } };
    expect(manifest.background.service_worker).toBe(WORKER_PATH);
  });
});
