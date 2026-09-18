import { describe, expect, it, vi } from "vitest";

import {
  readBoundedResponseBytes,
  ResponseBodyTooLargeError,
} from "../../src/bounded-response.js";

describe("bounded response reader", () => {
  it("assembles a response without exceeding the byte limit", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3]));
          controller.close();
        },
      }),
    );

    await expect(readBoundedResponseBytes(response, 3)).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("rejects an oversized declared content length before reading", async () => {
    const response = new Response(new Uint8Array([1]), {
      headers: { "content-length": "4" },
    });

    await expect(readBoundedResponseBytes(response, 3)).rejects.toBeInstanceOf(
      ResponseBodyTooLargeError,
    );
  });

  it("cancels a streaming body as soon as chunks exceed the limit", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3, 4]));
        },
        cancel,
      }),
    );

    await expect(readBoundedResponseBytes(response, 3)).rejects.toBeInstanceOf(
      ResponseBodyTooLargeError,
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels the reader when its owning verification is aborted", async () => {
    const cancel = vi.fn();
    const controller = new AbortController();
    controller.abort("user-cancelled");
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel,
      }),
    );

    await expect(
      readBoundedResponseBytes(response, 3, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
