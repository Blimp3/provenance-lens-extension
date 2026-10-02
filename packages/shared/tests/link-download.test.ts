import { LinkDownloadOptionsSchema } from "../src/index.js";

// The same rules DigiBot's link-download route applies since DigiBot 5.0.0: an output of
// "mp3" or nothing, and an integer clip with both bounds, 0 <= start < end <= 86400.
describe("link-download options", () => {
  it("accepts the options DigiBot's route takes", () => {
    const clip = { startSeconds: 65, endSeconds: 120 };
    for (const options of [
      {},
      { output: "mp3" },
      clip,
      { output: "mp3", ...clip },
      { startSeconds: 0, endSeconds: 86_400 },
    ]) {
      expect(
        LinkDownloadOptionsSchema.parse(options),
        JSON.stringify(options),
      ).toEqual(options);
    }
  });

  it.each([
    { startSeconds: 65 },
    { endSeconds: 120 },
    { startSeconds: 5, endSeconds: null },
    { startSeconds: 120, endSeconds: 65 },
    { startSeconds: 65, endSeconds: 65 },
    { startSeconds: 4.5, endSeconds: 20 },
    { startSeconds: "65", endSeconds: 120 },
    { startSeconds: -1, endSeconds: 20 },
    { startSeconds: 0, endSeconds: 86_401 },
    { output: "m4a" },
    { output: "MP3" },
    { output: null },
    { output: 1 },
    { output: "mp3", quality: "320k" },
  ])("rejects the options %j", (options) => {
    expect(LinkDownloadOptionsSchema.safeParse(options).success).toBe(false);
  });

  it("names the missing or inverted bound", () => {
    expect(
      LinkDownloadOptionsSchema.safeParse({ startSeconds: 65 }).error?.issues,
    ).toMatchObject([{ path: ["endSeconds"] }]);
    expect(
      LinkDownloadOptionsSchema.safeParse({ endSeconds: 120 }).error?.issues,
    ).toMatchObject([{ path: ["startSeconds"] }]);
    expect(
      LinkDownloadOptionsSchema.safeParse({ startSeconds: 120, endSeconds: 65 })
        .error?.issues,
    ).toMatchObject([
      { path: ["endSeconds"], message: "The clip must start before it ends." },
    ]);
  });
});
