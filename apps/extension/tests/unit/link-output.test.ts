import { describe, expect, it } from "vitest";

import {
  CLIP_FORMAT_MESSAGE,
  CLIP_LIMIT_MESSAGE,
  CLIP_ORDER_MESSAGE,
  LINK_OUTPUT_LABELS,
  parseClock,
  parseClockRange,
} from "../../src/ui/link-output.js";

describe("page-link output controls", () => {
  it.each([
    ["0", 0],
    ["65", 65],
    [" 120 ", 120],
    ["1:05", 65],
    ["2:00", 120],
    ["90:00", 5400],
    ["1:02:03", 3723],
    ["24:00:00", 86400],
    ["024:00:00", 86400],
    ["100:00:00", 360000],
    ["10000:00", 600000],
    ["1234567", 1234567],
  ])("reads %s as %i seconds", (text, seconds) => {
    expect(parseClock(text)).toBe(seconds);
  });

  it.each([
    "",
    "1:5",
    "1:60",
    "1:2:03",
    "1:60:00",
    "0:00:60",
    "-5",
    "1.5",
    "5s",
    "1:05:",
    ":05",
    "1:05:00:00",
  ])("rejects the clock value %j", (text) => {
    expect(parseClock(text)).toBeNull();
  });

  it("names each output in a progress toast, with no MP3", () => {
    expect(LINK_OUTPUT_LABELS).toEqual({
      video: "Video",
      voice: "Voice note",
      m4a: "Audio file",
      clip: "Clip",
    });
  });

  it("turns a clip range's clock values into seconds", () => {
    expect(parseClockRange("1:05-2:00")).toEqual({
      ok: true,
      startSeconds: 65,
      endSeconds: 120,
    });
    expect(parseClockRange("0-24:00:00")).toEqual({
      ok: true,
      startSeconds: 0,
      endSeconds: 86400,
    });
  });

  it("refuses a clip beyond 24 hours or one that ends before it starts", () => {
    for (const text of ["0-24:00:01", "86401-86402"])
      expect(parseClockRange(text)).toEqual({
        ok: false,
        message: CLIP_LIMIT_MESSAGE,
      });
    // Uncapped digits parse, so an over-long value gets the limit message.
    for (const end of ["1234567", "100:00:00", "10000:00"])
      expect(parseClockRange(`0-${end}`)).toEqual({
        ok: false,
        message: CLIP_LIMIT_MESSAGE,
      });
    for (const text of ["2:00-2:00", "2:00-1:05"])
      expect(parseClockRange(text)).toEqual({
        ok: false,
        message: CLIP_ORDER_MESSAGE,
      });
    expect(parseClockRange("1:05-2:0")).toEqual({
      ok: false,
      message: CLIP_FORMAT_MESSAGE,
    });
  });
});
