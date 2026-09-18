import {
  OPENAI_VERIFY_URL,
  type ImageSelection,
} from "@provenance-lens/shared";
import { describe, expect, it, vi } from "vitest";

import {
  verifySelectionOnWebsite,
  type WebsiteBrowser,
} from "../../src/actions/verify-openai-website.js";

const selection: ImageSelection = {
  url: "https://page.example/image.png",
  sourceKind: "img",
  pageOrigin: "https://page.example",
  sourceHostname: "page.example",
  pageTitle: "Fixture",
  rect: {
    x: 0,
    y: 0,
    width: 2,
    height: 2,
    viewportWidth: 100,
    viewportHeight: 100,
    devicePixelRatio: 1,
  },
};

const imageBytes = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4,
]);

function browserMocks(): WebsiteBrowser & {
  download: ReturnType<typeof vi.fn>;
  createTab: ReturnType<typeof vi.fn>;
} {
  return {
    download: vi.fn(() => Promise.resolve(42)),
    createTab: vi.fn(() => Promise.resolve({} as chrome.tabs.Tab)),
  };
}

function fetchImage(): typeof fetch {
  return vi.fn(() =>
    Promise.resolve(
      new Response(imageBytes, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    ),
  );
}

function decodeDataUrl(value: string): Uint8Array {
  const separator = value.indexOf(",");
  expect(separator).toBeGreaterThan(0);
  const encoded = value.slice(separator + 1);
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

describe("Website verification action", () => {
  it("downloads the exact retrieved bytes and opens official Verify", async () => {
    const browser = browserMocks();
    const result = await verifySelectionOnWebsite(
      selection,
      { fetchImpl: fetchImage() },
      browser,
    );

    expect(result).toEqual({
      kind: "website",
      status: "opened",
      message:
        "The exact image was downloaded. Upload it to OpenAI Verify to review its supported provenance signals.",
    });
    expect(browser.download).toHaveBeenCalledTimes(1);
    const options = browser.download.mock.calls[0]?.[0] as {
      url: string;
      filename: string;
      conflictAction: string;
      saveAs: boolean;
    };
    expect(options).toMatchObject({
      filename: "selected-image.png",
      conflictAction: "uniquify",
      saveAs: false,
    });
    expect(decodeDataUrl(options.url)).toEqual(imageBytes);
    expect(browser.createTab).toHaveBeenCalledWith({ url: OPENAI_VERIFY_URL });
  });

  it("does not open Verify when browser download permission is unavailable", async () => {
    const browser = browserMocks();
    browser.download.mockRejectedValue(new Error("permission denied"));

    await expect(
      verifySelectionOnWebsite(selection, { fetchImpl: fetchImage() }, browser),
    ).resolves.toEqual({
      kind: "website",
      status: "error",
      errorCode: "permission_denied",
      message:
        "Grant optional download access from the popup or Settings before using Website mode.",
    });
    expect(browser.createTab).not.toHaveBeenCalled();
  });

  it("keeps the downloaded file manual when Verify cannot be opened", async () => {
    const browser = browserMocks();
    browser.createTab.mockRejectedValue(new Error("tab creation denied"));

    await expect(
      verifySelectionOnWebsite(selection, { fetchImpl: fetchImage() }, browser),
    ).resolves.toEqual({
      kind: "website",
      status: "error",
      errorCode: "invalid_request",
      message:
        "The exact image was downloaded, but OpenAI Verify could not be opened. Open it manually to upload the file.",
    });
    expect(browser.download).toHaveBeenCalledTimes(1);
  });

  it("reports user cancellation without downloading or opening Verify", async () => {
    const browser = browserMocks();
    const controller = new AbortController();
    controller.abort();

    await expect(
      verifySelectionOnWebsite(
        selection,
        { signal: controller.signal, fetchImpl: fetchImage() },
        browser,
      ),
    ).resolves.toEqual({
      kind: "website",
      status: "cancelled",
      message: "Website verification was cancelled by the user.",
    });
    expect(browser.download).not.toHaveBeenCalled();
    expect(browser.createTab).not.toHaveBeenCalled();
  });

  it("returns a distinct website error without caching or a normalized verdict when retrieval fails", async () => {
    const browser = browserMocks();
    const fetchImpl = vi.fn(() => Promise.reject(new Error("network down")));

    await expect(
      verifySelectionOnWebsite(
        selection,
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          hasHostPermission: () => Promise.resolve(true),
        },
        browser,
      ),
    ).resolves.toMatchObject({
      kind: "website",
      status: "error",
      errorCode: "image_retrieval_failed",
    });
    expect(browser.download).not.toHaveBeenCalled();
    expect(browser.createTab).not.toHaveBeenCalled();
  });
});
