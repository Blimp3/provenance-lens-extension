import { describe, expect, it } from "vitest";

import {
  resolveCancellationTabId,
  routeActionRequest,
} from "../../src/routing.js";

const selection = {
  url: "https://page.example/image.png",
  sourceKind: "img" as const,
  pageOrigin: "https://page.example",
  sourceHostname: "page.example",
  pageTitle: "Fixture",
  rect: {
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    viewportWidth: 100,
    viewportHeight: 100,
    devicePixelRatio: 1,
  },
};

describe("action routing", () => {
  it.each(["popup", "keyboard", "context-menu"] as const)(
    "routes %s without a selection to the picker",
    (trigger) => {
      expect(routeActionRequest(trigger)).toEqual({ kind: "pick", trigger });
    },
  );

  it.each(["popup", "keyboard", "context-menu"] as const)(
    "routes %s with a selection through the verification action",
    (trigger) => {
      expect(routeActionRequest(trigger, selection)).toEqual({
        kind: "verify-selection",
        trigger,
        selection,
      });
    },
  );

  it("resolves popup cancellation to the focused active verification tab", () => {
    expect(resolveCancellationTabId(undefined, [7, 9], 9)).toBe(9);
    expect(resolveCancellationTabId(undefined, [7], 9)).toBe(7);
    expect(resolveCancellationTabId(undefined, [7, 9], 11)).toBeUndefined();
    expect(resolveCancellationTabId(7, [7, 9], 9)).toBe(7);
  });
});
