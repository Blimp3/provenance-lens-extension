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

  it("registers the palette listeners once and shares one menu rebuild", async () => {
    const onInstalled = event();
    const onStartup = event();
    const onActionClicked = event();
    const onConnect = event();
    const onRemoved = event();
    const onMenuClicked = event();
    const removeAll = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn(
      (_item: chrome.contextMenus.CreateProperties, callback?: () => void) => {
        callback?.();
      },
    );
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        runtime: {
          onInstalled,
          onStartup,
          onMessage: event(),
          onConnect,
          lastError: undefined,
        },
        commands: { onCommand: event() },
        action: { onClicked: onActionClicked },
        tabs: { onRemoved },
        contextMenus: { removeAll, create, onClicked: onMenuClicked },
        storage: {
          onChanged: event(),
          local: { setAccessLevel: vi.fn().mockResolvedValue(undefined) },
          session: { setAccessLevel: vi.fn().mockResolvedValue(undefined) },
        },
      },
    });

    await import("../../src/background.js");
    for (const listener of [
      onActionClicked,
      onConnect,
      onRemoved,
      onMenuClicked,
    ])
      expect(listener.addListener).toHaveBeenCalledTimes(1);

    const installed = onInstalled.addListener.mock.calls[0]?.[0] as () => void;
    const started = onStartup.addListener.mock.calls[0]?.[0] as () => void;
    installed();
    started();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(11));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(removeAll).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(11);
    const ids = create.mock.calls.map(([item]) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
