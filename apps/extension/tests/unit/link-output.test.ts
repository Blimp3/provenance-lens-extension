import { describe, expect, it } from "vitest";

import {
  CLIP_FORMAT_MESSAGE,
  CLIP_LIMIT_MESSAGE,
  CLIP_ORDER_MESSAGE,
  LINK_OUTPUT_LABELS,
  LINK_OUTPUTS,
  isLinkOutput,
  linkOptionsFor,
  parseClock,
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

  it("lists the outputs the dropdown offers", () => {
    expect(LINK_OUTPUTS).toEqual(["video", "mp3", "clip"]);
    expect(LINK_OUTPUTS.map((output) => LINK_OUTPUT_LABELS[output])).toEqual([
      "Video",
      "MP3",
      "Clip",
    ]);
    expect(isLinkOutput("mp3")).toBe(true);
    expect(isLinkOutput("m4a")).toBe(false);
  });

  it("sends no options for a video and only the output for an MP3", () => {
    expect(linkOptionsFor("video", "1:05", "2:00")).toEqual({
      ok: true,
      options: null,
    });
    expect(linkOptionsFor("mp3", "", "")).toEqual({
      ok: true,
      options: { output: "mp3" },
    });
  });

  it("turns a clip's clock values into seconds", () => {
    expect(linkOptionsFor("clip", "1:05", "2:00")).toEqual({
      ok: true,
      options: { startSeconds: 65, endSeconds: 120 },
    });
    expect(linkOptionsFor("clip", "0", "24:00:00")).toEqual({
      ok: true,
      options: { startSeconds: 0, endSeconds: 86400 },
    });
  });

  it("names the clip fields that are not clock values", () => {
    expect(linkOptionsFor("clip", "", "")).toEqual({
      ok: false,
      message: CLIP_FORMAT_MESSAGE,
      fields: ["start", "end"],
    });
    expect(linkOptionsFor("clip", "1:05", "2:0")).toEqual({
      ok: false,
      message: CLIP_FORMAT_MESSAGE,
      fields: ["end"],
    });
  });

  it("refuses a clip beyond 24 hours or one that ends before it starts", () => {
    expect(linkOptionsFor("clip", "0", "24:00:01")).toEqual({
      ok: false,
      message: CLIP_LIMIT_MESSAGE,
      fields: ["end"],
    });
    expect(linkOptionsFor("clip", "86401", "86402")).toEqual({
      ok: false,
      message: CLIP_LIMIT_MESSAGE,
      fields: ["start", "end"],
    });
    // Uncapped digits parse, so an over-long value gets the limit message.
    for (const end of ["1234567", "100:00:00", "10000:00"]) {
      expect(linkOptionsFor("clip", "0", end)).toEqual({
        ok: false,
        message: CLIP_LIMIT_MESSAGE,
        fields: ["end"],
      });
    }
    for (const [start, end] of [
      ["2:00", "2:00"],
      ["2:00", "1:05"],
    ] as const) {
      expect(linkOptionsFor("clip", start, end)).toEqual({
        ok: false,
        message: CLIP_ORDER_MESSAGE,
        fields: ["end"],
      });
    }
  });
});
