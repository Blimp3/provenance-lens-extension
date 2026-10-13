import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ACTION_ID,
  AUDIO_ACTION_ID,
  DOWNLOAD_ACTION_ID,
  LINK_ACTION_ID,
  PICK_VIDEO_ACTION_ID,
} from "@provenance-lens/shared";
import { describe, expect, it } from "vitest";

import {
  CLIP_FORMAT_MESSAGE,
  CLIP_LIMIT_MESSAGE,
  CLIP_ORDER_MESSAGE,
} from "../../src/ui/link-output.js";
import {
  ALIAS_RULE,
  checkAlias,
  COMMAND_ROUTES,
  commandGate,
  commandRoute,
  DECLARED_COMMAND_IDS,
  effectiveAliases,
  fitsAudioCheck,
  formatClock,
  formatDuration,
  matchScore,
  NO_PAGE_REASON,
  PALETTE_COMMANDS,
  paletteCommand,
  parseClockRange,
  parsePaletteOpenRecord,
  parsePalettePrefs,
  rankRows,
  shortcutKeys,
  SYNTHID_ROW_NOTE,
  withAlias,
  withLastUsed,
  type PaletteContext,
  type PalettePrefs,
} from "../../src/ui/palette-commands.js";
import { LENS_TOKENS } from "../../src/ui/tokens.js";

const TOKEN = "123e4567-e89b-42d3-a456-426614174000";
const NO_PREFS: PalettePrefs = { aliases: {}, lastUsed: [] };

function context(overrides: Partial<PaletteContext> = {}): PaletteContext {
  return {
    host: "page",
    page: "web",
    hostname: "www.youtube.com",
    scope: "page",
    needsPick: false,
    connected: true,
    downloadAccess: true,
    verifyMode: "DigiBot check",
    range: null,
    ...overrides,
  };
}

function entry(id: string) {
  const found = paletteCommand(id);
  if (!found) throw new Error(`no command ${id}`);
  return found;
}

describe("the palette's browser commands", () => {
  it("routes the manifest's 11 commands in its order", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../manifest.json"), "utf8"),
    ) as { commands: Record<string, unknown> };
    expect(Object.keys(manifest.commands)).toEqual([...DECLARED_COMMAND_IDS]);
    expect(Object.keys(COMMAND_ROUTES)).toEqual([...DECLARED_COMMAND_IDS]);
  });

  it("maps each command to its palette view, action or cancel", () => {
    expect(commandRoute("open-palette")).toEqual({
      kind: "palette",
      view: "root",
    });
    expect(commandRoute("open-clip")).toEqual({
      kind: "palette",
      view: "clip",
    });
    expect(commandRoute("pick-image")).toEqual({
      kind: "start",
      actionId: ACTION_ID,
    });
    expect(commandRoute("send-page-video")).toEqual({
      kind: "start",
      actionId: LINK_ACTION_ID,
    });
    expect(commandRoute("send-page-audio")).toEqual({
      kind: "start",
      actionId: LINK_ACTION_ID,
      options: { output: "voice" },
    });
    expect(commandRoute("send-page-audio-file")).toEqual({
      kind: "start",
      actionId: LINK_ACTION_ID,
      options: { output: "m4a" },
    });
    expect(commandRoute("pick-post-video")).toEqual({
      kind: "start",
      actionId: PICK_VIDEO_ACTION_ID,
    });
    expect(commandRoute("pick-post-audio")).toEqual({
      kind: "start",
      actionId: PICK_VIDEO_ACTION_ID,
      options: { output: "voice" },
    });
    expect(commandRoute("pick-post-audio-file")).toEqual({
      kind: "start",
      actionId: PICK_VIDEO_ACTION_ID,
      options: { output: "m4a" },
    });
    expect(commandRoute("pick-image-telegram")).toEqual({
      kind: "start",
      actionId: DOWNLOAD_ACTION_ID,
    });
    expect(commandRoute("cancel-active")).toEqual({ kind: "cancel" });
    expect(commandRoute("_execute_action")).toBeNull();
    expect(commandRoute("toString")).toBeNull();
  });

  it("gives every declared command a palette row with the same action", () => {
    for (const id of DECLARED_COMMAND_IDS) {
      if (id === "open-palette") continue;
      const route = COMMAND_ROUTES[id];
      const row = entry(id);
      if (route.kind === "start") expect(row.run).toEqual(route);
      else if (route.kind === "cancel") expect(row.run).toEqual(route);
      else expect(row.run).toEqual({ kind: "view", view: route.view });
    }
  });

  it("splits a shortcut into keycaps on every platform", () => {
    expect(shortcutKeys("Alt+Shift+Space")).toEqual(["Alt", "Shift", "Space"]);
    expect(shortcutKeys("⌥⇧Space")).toEqual(["⌥", "⇧", "Space"]);
    expect(shortcutKeys("⌥⇧V")).toEqual(["⌥", "⇧", "V"]);
    expect(shortcutKeys("")).toEqual([]);
  });
});

describe("the palette open record", () => {
  const record = {
    token: TOKEN,
    tabId: 7,
    view: "download",
    host: "page",
    page: "web",
    hostname: "x.com",
    scope: "video",
    needsPick: true,
  };

  it("keeps a valid record and nothing more", () => {
    expect(
      parsePaletteOpenRecord({ ...record, url: "https://x.com/a" }),
    ).toEqual(record);
    for (const host of ["popup", "tab"])
      expect(parsePaletteOpenRecord({ ...record, host })).toEqual({
        ...record,
        host,
      });
  });

  it("refuses a record with a bad token, tab, view, host or page", () => {
    for (const change of [
      { token: "not-a-token" },
      { token: TOKEN.toUpperCase() },
      { tabId: -1 },
      { tabId: 1.5 },
      { view: "verify" },
      { host: "frame" },
      { page: "chrome" },
      { scope: "audio" },
      { needsPick: "yes" },
      { hostname: "a".repeat(256) },
    ])
      expect(parsePaletteOpenRecord({ ...record, ...change })).toBeNull();
    expect(parsePaletteOpenRecord(null)).toBeNull();
    expect(parsePaletteOpenRecord("token")).toBeNull();
  });
});

describe("palette ranking", () => {
  it("orders an exact alias, alias prefix, title prefix, word start, substring and subsequence", () => {
    expect(matchScore("v", "Pick an image to verify…", "v")).toBe(6000);
    expect(matchScore("v", "Verify an audio file…", "va")).toBe(5000);
    expect(matchScore("ver", "Verify")).toBe(4000);
    expect(matchScore("ima", "Pick an image to verify…")).toBe(3000);
    expect(matchScore("erif", "Verify")).toBe(2000);
    expect(matchScore("sdv", "Send video")).toBeGreaterThan(0);
    expect(matchScore("sdv", "Send video")).toBeLessThan(1000);
    expect(matchScore("zz", "Send video")).toBe(0);
    expect(matchScore("  ", "Send video")).toBe(1);
  });

  it("drops rows that do not match and breaks ties by Last used, then table order", () => {
    const rows = [
      { id: "a", title: "Send video" },
      { id: "b", title: "Send audio" },
      { id: "c", title: "Settings" },
      { id: "d", title: "Recent" },
    ];
    expect(rankRows("se", rows, []).map((row) => row.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(rankRows("send", rows, ["b"]).map((row) => row.id)).toEqual([
      "b",
      "a",
    ]);
    expect(rankRows("rec", rows, []).map((row) => row.id)).toEqual(["d"]);
  });

  it("puts a user's alias first", () => {
    const aliases = effectiveAliases({
      aliases: { "send-page-audio": "mp" },
      lastUsed: [],
    });
    const rows = PALETTE_COMMANDS.map((row) => ({
      ...row,
      ...(aliases[row.id] ? { alias: aliases[row.id] } : {}),
    }));
    expect(rankRows("mp", rows, [])[0]?.id).toBe("send-page-audio");
    expect(rankRows("v", rows, [])[0]?.id).toBe("pick-image");
  });
});

describe("palette aliases and Last used", () => {
  it("uses the table's default aliases, a user's alias and a cleared alias", () => {
    const defaults = effectiveAliases(NO_PREFS);
    expect(defaults["send-page-video"]).toBe("d");
    expect(defaults["check-synthid"]).toBe("g");
    const changed = effectiveAliases({
      aliases: { "send-page-video": "vid", "pick-image": null },
      lastUsed: [],
    });
    expect(changed["send-page-video"]).toBe("vid");
    expect(changed["pick-image"]).toBeUndefined();
  });

  it("keeps the default aliases unique", () => {
    const aliases = Object.values(effectiveAliases(NO_PREFS));
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it("accepts 1 to 12 characters from a-z, 0-9 and - used by no other command", () => {
    const aliases = effectiveAliases(NO_PREFS);
    expect(checkAlias(" Clip2 ", "open-clip", aliases)).toEqual({
      ok: true,
      alias: "clip2",
    });
    expect(checkAlias("", "open-clip", aliases)).toEqual({
      ok: true,
      alias: null,
    });
    expect(checkAlias("c", "open-clip", aliases)).toEqual({
      ok: true,
      alias: "c",
    });
    for (const bad of ["a b", "ab_c", "é", "a".repeat(13)])
      expect(checkAlias(bad, "open-clip", aliases)).toEqual({
        ok: false,
        message: ALIAS_RULE,
      });
    expect(checkAlias("d", "open-clip", aliases)).toEqual({
      ok: false,
      message: "Already used by Send video",
    });
  });

  it("stores only the aliases that differ from the default", () => {
    const set = withAlias(NO_PREFS, "send-page-video", "vid");
    expect(set.aliases).toEqual({ "send-page-video": "vid" });
    expect(withAlias(set, "send-page-video", "d").aliases).toEqual({});
    expect(withAlias(NO_PREFS, "send-page-video", null).aliases).toEqual({
      "send-page-video": null,
    });
  });

  it("keeps the 3 most recent leaf commands, most recent first", () => {
    let prefs = NO_PREFS;
    for (const id of [
      "send-page-video",
      "pick-image",
      "send-page-audio",
      "open-history",
      "pick-image",
    ])
      prefs = withLastUsed(prefs, id);
    expect(prefs.lastUsed).toEqual([
      "pick-image",
      "open-history",
      "send-page-audio",
    ]);
    expect(withLastUsed(prefs, "view-download")).toBe(prefs);
    expect(withLastUsed(prefs, "send-clip")).toBe(prefs);
  });

  it("reads stored prefs and drops unknown ids, bad aliases and non-leaf rows", () => {
    expect(
      parsePalettePrefs({
        aliases: {
          "send-page-video": "vid",
          "pick-image": null,
          "open-clip": "BAD ALIAS",
          gone: "x",
        },
        lastUsed: [
          "pick-image",
          "view-verify",
          "pick-image",
          "gone",
          "open-history",
          "send-page-audio",
          "send-page-video",
        ],
      }),
    ).toEqual({
      aliases: { "send-page-video": "vid", "pick-image": null },
      lastUsed: ["pick-image", "open-history", "send-page-audio"],
    });
    expect(parsePalettePrefs(undefined)).toEqual(NO_PREFS);
  });
});

describe("palette gating", () => {
  it("disables page commands off web pages with the host's reason", () => {
    expect(
      commandGate(entry("pick-image"), context({ page: "link-only" })),
    ).toEqual({ reason: "Not on browser pages", disabled: true });
    expect(
      commandGate(entry("pick-image"), context({ host: "tab", page: "none" })),
    ).toEqual({ reason: NO_PAGE_REASON, disabled: true });
  });

  it("lets link commands run on a protected http page but not on a browser page", () => {
    expect(
      commandGate(entry("send-page-video"), context({ page: "link-only" })),
    ).toBeNull();
    expect(
      commandGate(entry("send-page-video"), context({ page: "none" })),
    ).toEqual({ reason: "Not on browser pages", disabled: true });
  });

  it("checks the page before DigiBot, DigiBot before download access, and the range last", () => {
    expect(
      commandGate(
        entry("pick-post-video"),
        context({ page: "none", connected: false }),
      )?.reason,
    ).toBe("Not on browser pages");
    expect(
      commandGate(entry("send-page-video"), context({ connected: false })),
    ).toEqual({
      reason: "Needs DigiBot",
      disabled: false,
      fix: { kind: "tab", page: "connect" },
    });
    expect(
      commandGate(entry("check-synthid"), context({ downloadAccess: false })),
    ).toEqual({
      reason: "Needs download access",
      disabled: false,
      fix: { kind: "tab", page: "access" },
    });
    expect(commandGate(entry("send-clip"), context())).toEqual({
      reason: "Enter a range first",
      disabled: true,
    });
    expect(
      commandGate(
        entry("send-clip"),
        context({ range: parseClockRange("1:30-2:10") }),
      ),
    ).toBeNull();
    expect(commandGate(entry("verify-audio-file"), context())).toBeNull();
  });
});

describe("the palette's Verify rows", () => {
  it("shows the SynthID note under the SynthID row", () => {
    expect(SYNTHID_ROW_NOTE).toBe(
      "Google has no SynthID API yet, so Lens opens Google's SynthID Detector with your file. Lens will check it directly once Google releases an API.",
    );
    expect(entry("check-synthid")).toMatchObject({
      title: "Check with Google SynthID…",
      note: SYNTHID_ROW_NOTE,
      external: true,
    });
  });

  it("opens the audio page for a file and keeps the segment check in the worker", () => {
    expect(entry("verify-audio-file").run).toEqual({
      kind: "start",
      actionId: AUDIO_ACTION_ID,
    });
    expect(entry("verify-clip-audio").run).toEqual({
      kind: "start",
      actionId: AUDIO_ACTION_ID,
      range: true,
    });
  });
});

describe("the palette's range field", () => {
  it("reads the four range forms", () => {
    expect(parseClockRange("1:30-2:10")).toEqual({
      ok: true,
      startSeconds: 90,
      endSeconds: 130,
    });
    expect(parseClockRange(" 1:30 2:10 ")).toEqual({
      ok: true,
      startSeconds: 90,
      endSeconds: 130,
    });
    expect(parseClockRange("90 - 130")).toEqual({
      ok: true,
      startSeconds: 90,
      endSeconds: 130,
    });
    expect(parseClockRange("1:02:03-1:05:00")).toEqual({
      ok: true,
      startSeconds: 3723,
      endSeconds: 3900,
    });
  });

  it("names what is wrong with a range", () => {
    for (const text of ["", "1:30", "1:30-2:10-3:00", "1:3-2:10", "a-b"])
      expect(parseClockRange(text)).toEqual({
        ok: false,
        message: CLIP_FORMAT_MESSAGE,
      });
    expect(parseClockRange("2:10-1:30")).toEqual({
      ok: false,
      message: CLIP_ORDER_MESSAGE,
    });
    expect(parseClockRange("0-24:00:01")).toEqual({
      ok: false,
      message: CLIP_LIMIT_MESSAGE,
    });
  });

  it("fits an audio check only from 1 to 60 s", () => {
    expect(fitsAudioCheck(parseClockRange("0-60"))).toBe(true);
    expect(fitsAudioCheck(parseClockRange("10-11"))).toBe(true);
    expect(fitsAudioCheck(parseClockRange("0-61"))).toBe(false);
    expect(fitsAudioCheck(parseClockRange("2:10-1:30"))).toBe(false);
    expect(fitsAudioCheck(null)).toBe(false);
  });

  it("formats clocks and durations", () => {
    expect(formatClock(90)).toBe("1:30");
    expect(formatClock(3723)).toBe("1:02:03");
    expect(formatClock(5)).toBe("0:05");
    expect(formatDuration(40)).toBe("40 s");
    expect(formatDuration(120)).toBe("2 min");
    expect(formatDuration(125)).toBe("2 min 5 s");
  });
});

describe("the palette's color tokens", () => {
  it("match the tokens the picker, banner and toast use", () => {
    const css = readFileSync(
      resolve(import.meta.dirname, "../../public/palette.css"),
      "utf8",
    );
    const light: Record<string, string> = {};
    const dark: Record<string, string> = {};
    for (const [, name, lightValue, darkValue] of css.matchAll(
      /(--lens-[a-z0-9-]+):\s*light-dark\((#[0-9a-f]+),\s*(#[0-9a-f]+)\);/giu,
    )) {
      light[name as string] = (lightValue as string).toUpperCase();
      dark[name as string] = (darkValue as string).toUpperCase();
    }
    const shadows = [...css.matchAll(/--lens-shadow:\s*([^;]+);/gu)].map(
      (match) => (match[1] as string).toUpperCase(),
    );
    light["--lens-shadow"] = shadows[0] ?? "";
    dark["--lens-shadow"] = shadows[1] ?? "";

    const upper = (tokens: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(tokens).map(([name, value]) => [
          name,
          value.toUpperCase(),
        ]),
      );
    expect(light).toEqual(upper(LENS_TOKENS.light));
    expect(dark).toEqual(upper(LENS_TOKENS.dark));
  });
});
