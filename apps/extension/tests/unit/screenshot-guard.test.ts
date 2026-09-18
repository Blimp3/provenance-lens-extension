import { describe, expect, it } from "vitest";

import {
  assertScreenshotDataUrlBudget,
  assertScreenshotPixelBudget,
  ScreenshotTooLargeError,
} from "../../src/screenshot-guard.js";

describe("screenshot memory and encoded-size guards", () => {
  it("rejects a viewport whose decoded RGBA pixels exceed the budget", () => {
    expect(() => assertScreenshotPixelBudget(2, 2, 1, 15)).toThrow(
      ScreenshotTooLargeError,
    );
    expect(() => assertScreenshotPixelBudget(2, 2, 1, 16)).not.toThrow();
  });

  it("rejects an encoded screenshot before decoding when it exceeds the budget", () => {
    expect(() =>
      assertScreenshotDataUrlBudget("data:image/png;base64,AQIDBA==", 3),
    ).toThrow(ScreenshotTooLargeError);
    expect(() =>
      assertScreenshotDataUrlBudget("data:image/png;base64,AQIDBA==", 4),
    ).not.toThrow();
  });
});
