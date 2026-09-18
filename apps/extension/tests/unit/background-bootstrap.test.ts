import { beforeEach, describe, expect, it, vi } from "vitest";

function event() {
  return { addListener: vi.fn() };
}

describe("background bootstrap", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("keeps booting when contextMenus is unavailable", async () => {
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        runtime: {
          onInstalled: event(),
          onStartup: event(),
          onMessage: event(),
        },
        commands: { onCommand: event() },
        storage: {
          onChanged: event(),
          local: { setAccessLevel: vi.fn().mockResolvedValue(undefined) },
          session: { setAccessLevel: vi.fn().mockResolvedValue(undefined) },
        },
      },
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(import("../../src/background.js")).resolves.toBeDefined();
      await Promise.resolve();
      await Promise.resolve();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
