import {
  ACTION_ID,
  AUDIO_ACTION_ID,
  DOWNLOAD_ACTION_ID,
  LINK_ACTION_ID,
  PICK_VIDEO_ACTION_ID,
  SYNTHID_ACTION_ID,
  type ActivityEntry,
} from "@provenance-lens/shared";
import { describe, expect, it } from "vitest";

import {
  activityAddress,
  activityEntry,
  activityTitle,
  linkActivityKind,
  recentRow,
  refusalState,
  startActivityKind,
} from "../../src/activity.js";

const RECORD_ID = "123e4567-e89b-42d3-a456-426614174000";
const OPERATION_ID = "223e4567-e89b-42d3-a456-426614174000";

function entry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: "323e4567-e89b-42d3-a456-426614174000",
    title: "Send video",
    kind: "page-link",
    tabId: 7,
    pageTitle: null,
    pageUrl: "https://page.example/watch",
    linkUrl: "https://page.example/watch",
    startedAt: "2026-10-14T20:00:00.000Z",
    state: "sent",
    message: "Queued in DigiBot. The result arrives in your Telegram chat.",
    operationId: OPERATION_ID,
    recordId: null,
    ...overrides,
  };
}

describe("Recent's entries", () => {
  it("names each start after its palette row", () => {
    expect(activityTitle(LINK_ACTION_ID)).toBe("Send video");
    expect(activityTitle(LINK_ACTION_ID, { output: "voice" })).toBe(
      "Send voice note",
    );
    expect(activityTitle(LINK_ACTION_ID, { output: "m4a" })).toBe(
      "Send audio file",
    );
    expect(
      activityTitle(LINK_ACTION_ID, { startSeconds: 1, endSeconds: 2 }),
    ).toBe("Send clip of this page");
    expect(activityTitle(DOWNLOAD_ACTION_ID)).toBe("Pick to download");
    expect(activityTitle(ACTION_ID)).toBe("Pick an image to verify");
    expect(activityTitle(SYNTHID_ACTION_ID)).toBe("Check with Google SynthID");
    expect(activityTitle(AUDIO_ACTION_ID)).toBe("Verify an audio file");
    expect(activityTitle(PICK_VIDEO_ACTION_ID, { output: "voice" })).toBe(
      "Pick a post → voice note",
    );
    // A retried download pick's video has no row of its own.
    expect(activityTitle(PICK_VIDEO_ACTION_ID)).toBe("Send the picked video");
  });

  it("gives each start its kind; a link send's output decides", () => {
    expect(startActivityKind(LINK_ACTION_ID)).toBe("page-link");
    expect(startActivityKind(PICK_VIDEO_ACTION_ID)).toBe("video");
    expect(startActivityKind(DOWNLOAD_ACTION_ID)).toBe("image");
    for (const actionId of [ACTION_ID, AUDIO_ACTION_ID, SYNTHID_ACTION_ID])
      expect(startActivityKind(actionId)).toBe("verify");
    expect(linkActivityKind({ output: "voice" }, "video")).toBe("voice");
    expect(linkActivityKind({ output: "m4a" }, "page-link")).toBe("audio-file");
    expect(
      linkActivityKind({ startSeconds: 1, endSeconds: 2 }, "page-link"),
    ).toBe("clip");
  });

  it("keeps only an http(s) address, without credentials or fragment", () => {
    expect(activityAddress("https://user:pass@page.example/a?b=1#token")).toBe(
      "https://page.example/a?b=1",
    );
    expect(activityAddress("chrome://extensions/")).toBeNull();
    expect(activityAddress("javascript:alert(1)")).toBeNull();
    expect(activityAddress(undefined)).toBeNull();
    expect(
      activityAddress(`https://page.example/${"a".repeat(2_100)}`),
    ).toBeNull();
  });

  it("starts an entry with the tab's page, and its title only when history keeps titles", () => {
    const tab = { id: 7, url: "https://page.example/#x", title: "A page" };
    const { id, startedAt, ...started } = activityEntry({
      title: "Send video",
      kind: "page-link",
      tab,
      includePageTitle: true,
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(Date.parse(startedAt)).not.toBeNaN();
    expect(started).toEqual({
      title: "Send video",
      kind: "page-link",
      tabId: 7,
      pageTitle: "A page",
      pageUrl: "https://page.example/",
      linkUrl: null,
      state: "running",
      message: null,
      operationId: null,
      recordId: null,
    });
    expect(
      activityEntry({
        title: "Send video",
        kind: "page-link",
        tab,
        includePageTitle: false,
      }).pageTitle,
    ).toBeNull();
    // A browser page keeps neither its address nor its title.
    expect(
      activityEntry({
        title: "Pick to download",
        kind: "image",
        tab: { id: 7, url: "chrome://newtab/", title: "New Tab" },
        includePageTitle: true,
      }),
    ).toMatchObject({ pageUrl: null, pageTitle: null });
  });

  it("tells a refusal from a failure", () => {
    expect(refusalState("protected_page")).toBe("refused");
    expect(refusalState("backend_configuration_missing")).toBe("refused");
    expect(refusalState("concurrency_limit")).toBe("refused");
    expect(refusalState("backend_unavailable")).toBe("failed");
    expect(refusalState("image_retrieval_failed")).toBe("failed");
  });
});

describe("Recent's rows", () => {
  const saved = new Set([RECORD_ID]);

  it("shows the kind icon, the state label and where the action ran", () => {
    expect(recentRow(entry(), saved, "2 min ago")).toEqual({
      title: "Send video",
      subtitle: "page.example · 2 min ago",
      icon: "link",
      state: "Sent",
      warn: false,
      open: { page: "address", url: "https://page.example/watch" },
    });
    for (const [kind, icon] of [
      ["image", "image"],
      ["video", "film"],
      ["audio-file", "music"],
      ["voice", "mic"],
      ["verify", "shield-check"],
      ["clip", "scissors"],
    ] as const)
      expect(recentRow(entry({ kind }), saved, "now").icon).toBe(icon);
    expect(
      recentRow(entry({ state: "running", message: null }), saved, "now").state,
    ).toBe("Started");
  });

  it("says why an action failed or was refused", () => {
    expect(
      recentRow(
        entry({
          kind: "image",
          state: "refused",
          message: "Connect DigiBot first.",
          pageTitle: "A page",
          operationId: null,
        }),
        saved,
        "1 h ago",
      ),
    ).toMatchObject({
      subtitle: "Connect DigiBot first. · A page · 1 h ago",
      state: "Refused",
      warn: true,
    });
    expect(
      recentRow(
        entry({ kind: "verify", state: "done", message: "No signal" }),
        saved,
        "now",
      ),
    ).toMatchObject({
      subtitle: "No signal · page.example · now",
      warn: false,
    });
  });

  it("opens a Verify entry's details, a DigiBot entry's Result history and a page link's address", () => {
    const verify = entry({
      kind: "verify",
      state: "done",
      recordId: RECORD_ID,
      operationId: null,
      linkUrl: null,
    });
    expect(recentRow(verify, saved, "now").open).toEqual({
      page: "details",
      recordId: RECORD_ID,
    });
    // Its record is gone: nothing to open.
    expect(recentRow(verify, new Set(), "now").open).toBeNull();
    // A connected check keeps its result in Result history.
    expect(
      recentRow(
        entry({ kind: "verify", state: "done", recordId: null }),
        saved,
        "now",
      ).open,
    ).toEqual({ page: "history" });
    for (const kind of [
      "image",
      "video",
      "voice",
      "audio-file",
      "clip",
    ] as const)
      expect(recentRow(entry({ kind }), saved, "now").open).toEqual({
        page: "history",
      });
    expect(
      recentRow(entry({ linkUrl: null, pageUrl: null }), saved, "now").open,
    ).toBeNull();
    expect(
      recentRow(entry({ linkUrl: "javascript:alert(1)" }), saved, "now").open,
    ).toBeNull();
  });
});
