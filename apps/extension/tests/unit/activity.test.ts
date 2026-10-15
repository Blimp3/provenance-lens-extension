import {
  ACTION_ID,
  AUDIO_ACTION_ID,
  DOWNLOAD_ACTION_ID,
  LINK_ACTION_ID,
  PICK_VIDEO_ACTION_ID,
  SYNTHID_ACTION_ID,
  type ActivityEntry,
  type IntegrationOperationStatus,
} from "@provenance-lens/shared";
import { describe, expect, it } from "vitest";

import {
  activityAddress,
  activityEntry,
  activityTitle,
  linkActivityKind,
  operationUpdate,
  recentRow,
  refusalState,
  STALE_ACTIVITY_MS,
  startActivityKind,
  STOPPED_MESSAGE,
} from "../../src/activity.js";
import { pageAddress } from "../../src/page-address.js";

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

  it("gives each start the kind of what Telegram gets", () => {
    // Send video and a picked video, such as a TED talk, send the video.
    expect(startActivityKind(LINK_ACTION_ID)).toBe("video");
    expect(startActivityKind(PICK_VIDEO_ACTION_ID)).toBe("video");
    expect(startActivityKind(LINK_ACTION_ID, { output: "voice" })).toBe(
      "voice",
    );
    expect(startActivityKind(PICK_VIDEO_ACTION_ID, { output: "mp3" })).toBe(
      "audio-file",
    );
    expect(
      startActivityKind(LINK_ACTION_ID, { startSeconds: 1, endSeconds: 2 }),
    ).toBe("clip");
    // A download pick's output is known only once its click picks.
    expect(startActivityKind(DOWNLOAD_ACTION_ID)).toBe("page-link");
    for (const actionId of [ACTION_ID, AUDIO_ACTION_ID, SYNTHID_ACTION_ID])
      expect(startActivityKind(actionId)).toBe("verify");
    expect(linkActivityKind({})).toBe("video");
    expect(linkActivityKind({ output: "voice" })).toBe("voice");
    expect(linkActivityKind({ output: "m4a" })).toBe("audio-file");
    expect(linkActivityKind({ startSeconds: 1, endSeconds: 2 })).toBe("clip");
  });

  it("keeps a sent link's address with its query, and only the origin and path of a page", () => {
    expect(activityAddress("https://user:pass@page.example/a?b=1#token")).toBe(
      "https://page.example/a?b=1",
    );
    expect(
      pageAddress("https://user:pass@page.example/reset?code=1&t=2#token"),
    ).toBe("https://page.example/reset");
    expect(pageAddress("chrome://extensions/")).toBeNull();
    expect(pageAddress(undefined)).toBeNull();
    expect(activityAddress("chrome://extensions/")).toBeNull();
    expect(activityAddress("javascript:alert(1)")).toBeNull();
    expect(activityAddress(undefined)).toBeNull();
    expect(
      activityAddress(`https://page.example/${"a".repeat(2_100)}`),
    ).toBeNull();
  });

  it("starts an entry with the tab's page, and its title only when history keeps titles", () => {
    const tab = {
      id: 7,
      url: "https://page.example/?code=secret#x",
      title: "A page",
    };
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

  it("ends a DigiBot operation's entry as its status says", () => {
    const status = (
      overrides: Partial<IntegrationOperationStatus>,
    ): IntegrationOperationStatus =>
      ({
        operationId: OPERATION_ID,
        action: "download",
        state: "queued",
        envelope: null,
        segment: null,
        error: null,
        ...overrides,
      }) as IntegrationOperationStatus;
    const failure = {
      code: "telegram_failed",
      message: "Telegram refused it.",
      retryable: false,
    } as IntegrationOperationStatus["error"];
    expect(operationUpdate(status({}), "image")).toEqual({
      state: "sent",
      message: "The image was sent to your DigiBot chat.",
      operationId: OPERATION_ID,
    });
    // A failed DigiBot image send is never "sent".
    expect(
      operationUpdate(status({ state: "failed", error: failure }), "image"),
    ).toEqual({
      state: "failed",
      message: "Telegram refused it.",
      operationId: OPERATION_ID,
    });
    expect(
      operationUpdate(
        status({ action: "check", state: "processing" }),
        "audio",
      ),
    ).toMatchObject({
      state: "sent",
      message: "The audio check is still processing.",
    });
    expect(
      operationUpdate(
        status({
          action: "check",
          state: "completed",
          envelope: {
            result: { evidence: { verdict: "no_supported_signal_found" } },
          },
        } as unknown as Partial<IntegrationOperationStatus>),
        "image",
      ).state,
    ).toBe("done");
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
    const running = entry({ state: "running", message: null });
    expect(
      recentRow(running, saved, "now", Date.parse(running.startedAt)).state,
    ).toBe("Started");
  });

  it("shows a cancelled action in the neutral tone", () => {
    expect(
      recentRow(
        entry({
          kind: "image",
          state: "cancelled",
          message: "Pick cancelled.",
        }),
        saved,
        "now",
      ),
    ).toMatchObject({
      subtitle: "page.example · now",
      state: "Cancelled",
      warn: false,
    });
  });

  it("shows a running entry older than ten minutes as stopped", () => {
    const startedAt = Date.parse("2026-10-14T20:00:00.000Z");
    const running = entry({ state: "running", message: null });
    expect(
      recentRow(running, saved, "now", startedAt + STALE_ACTIVITY_MS - 1).state,
    ).toBe("Started");
    expect(
      recentRow(running, saved, "now", startedAt + STALE_ACTIVITY_MS + 1),
    ).toMatchObject({
      subtitle: `${STOPPED_MESSAGE} · page.example · now`,
      state: "Failed",
      warn: true,
    });
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

  it("opens a Verify entry's details, a link send's address and Result history for another DigiBot send", () => {
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
    for (const kind of ["video", "voice", "audio-file", "clip"] as const)
      expect(recentRow(entry({ kind }), saved, "now").open).toEqual({
        page: "address",
        url: "https://page.example/watch",
      });
    for (const kind of [
      "image",
      "video",
      "voice",
      "audio-file",
      "clip",
    ] as const)
      expect(
        recentRow(entry({ kind, linkUrl: null }), saved, "now").open,
      ).toEqual({ page: "history" });
    expect(
      recentRow(entry({ linkUrl: null, pageUrl: null }), saved, "now").open,
    ).toBeNull();
    expect(
      recentRow(entry({ linkUrl: "javascript:alert(1)" }), saved, "now").open,
    ).toBeNull();
  });
});
