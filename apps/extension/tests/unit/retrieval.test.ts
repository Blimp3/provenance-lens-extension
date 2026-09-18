import { MAX_IMAGE_BYTES, type ImageSelection } from "@provenance-lens/shared";
import { describe, expect, it, vi } from "vitest";

import {
  retrieveSelectedImage,
  USER_CANCELLED_REASON,
} from "../../src/actions/verify-openai-provenance.js";

const selection: ImageSelection = {
  url: "https://images.example/image.png",
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

describe("credentialless exact-byte retrieval", () => {
  it("cancels the image stream when the user aborts a pending read", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(new ReadableStream<Uint8Array>({ cancel }), {
          headers: { "content-type": "image/png" },
        }),
      ),
    );
    const pending = retrieveSelectedImage(
      { ...selection, url: "https://page.example/image.png" },
      { fetchImpl, signal: controller.signal },
    );
    const rejected = expect(pending).rejects.toMatchObject({
      code: "user_cancelled",
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    controller.abort(USER_CANCELLED_REASON);
    await rejected;
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("allows a same-page image without a host permission", async () => {
    const samePageSelection = {
      ...selection,
      url: "https://page.example/image.png",
    };
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      ),
    );

    await expect(
      retrieveSelectedImage(samePageSelection, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toMatchObject({
      mime: "image/png",
      sourceUrl: "https://page.example/image.png",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("denies a cross-host image before making a request without host permission", async () => {
    const fetchImpl = vi.fn();
    await expect(
      retrieveSelectedImage(selection, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        hasHostPermission: () => Promise.resolve(false),
      }),
    ).rejects.toMatchObject({
      code: "permission_denied",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("checks permission on every redirect target", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://other.example/image.png" },
      }),
    );
    const hasHostPermission = vi.fn((url: URL) =>
      Promise.resolve(url.origin === "https://images.example"),
    );
    await expect(
      retrieveSelectedImage(selection, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        hasHostPermission,
      }),
    ).rejects.toMatchObject({
      code: "permission_denied",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(hasHostPermission).toHaveBeenCalledWith(
      new URL("https://other.example/image.png"),
    );
  });

  it("enforces the 50 MiB stream cap before processing the image", async () => {
    const oversized = new Uint8Array(MAX_IMAGE_BYTES + 1);
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(oversized, {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": String(oversized.byteLength),
          },
        }),
      ),
    );
    await expect(
      retrieveSelectedImage(
        { ...selection, pageOrigin: "https://images.example" },
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          hasHostPermission: () => Promise.resolve(true),
        },
      ),
    ).rejects.toMatchObject({
      code: "image_too_large",
    });
  });
});
