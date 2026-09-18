import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createLaunchPlan,
  deriveExtensionId,
  findBrowserPid,
  parseArguments,
  resolveBrowsers,
} from "./start-extension.mjs";

test("defaults to Brave Origin and parses Chrome or all-browser modes", () => {
  assert.deepEqual(parseArguments([]), {
    browser: "auto",
    dryRun: false,
    help: false,
    showPopup: false,
  });
  assert.deepEqual(parseArguments(["--browser=chrome", "--show-popup"]), {
    browser: "chrome",
    dryRun: false,
    help: false,
    showPopup: true,
  });
  assert.equal(parseArguments(["--browser", "all"]).browser, "all");
});

test("rejects normal Brave, unsupported browsers, and unknown options", () => {
  assert.throws(
    () => parseArguments(["--browser", "brave"]),
    /Normal Brave is intentionally excluded/u,
  );
  assert.throws(
    () => parseArguments(["--browser", "chromium"]),
    /Unsupported browser/u,
  );
  assert.throws(() => parseArguments(["--wat"]), /Unknown option/u);
  assert.throws(() => parseArguments(["--browser"]), /requires a value/u);
});

test("derives Chromium's stable unpacked-extension ID from the exact path", () => {
  assert.equal(
    deriveExtensionId("/Users/example/Provenance Lens/apps/extension/dist"),
    "ohmlmeafdmmgmijolldilhinfeemnfcj",
  );
});

test("resolves Brave Origin before Chrome and supports both", async () => {
  const available = async () => true;
  const automatic = await resolveBrowsers("auto", "darwin", available);
  const all = await resolveBrowsers("all", "darwin", available);

  assert.deepEqual(
    automatic.map((browser) => browser.name),
    ["brave-origin"],
  );
  assert.deepEqual(
    all.map((browser) => browser.name),
    ["brave-origin", "chrome"],
  );
});

test("fails clearly when a selected browser is unavailable", async () => {
  await assert.rejects(
    resolveBrowsers("chrome", "darwin", async () => false),
    /Google Chrome is not installed/u,
  );
  await assert.rejects(
    resolveBrowsers("auto", "darwin", async () => false),
    /Neither Brave Origin nor Google Chrome is installed/u,
  );
});

test("finds only the exact main browser executable", () => {
  const executable =
    "/Applications/Brave Origin.app/Contents/MacOS/Brave Origin";
  const processList = [
    `11 ${executable} Helper --type=renderer`,
    `12 ${executable}-other`,
    `13 ${executable}`,
  ].join("\n");

  assert.equal(findBrowserPid(processList, executable), 13);
  assert.equal(
    findBrowserPid("14 /Applications/Other Browser", executable),
    undefined,
  );
});

test("creates a dry-run plan for existing signed-in browser profiles", async () => {
  const browsers = [
    {
      applicationName: "Brave Origin",
      applicationPath: "/Applications/Brave Origin.app",
      executable: "/Applications/Brave Origin.app/Contents/MacOS/Brave Origin",
      extensionsUrl: "brave://extensions/",
      name: "brave-origin",
    },
  ];
  const plan = await createLaunchPlan({
    argv: ["--browser", "brave-origin", "--dry-run"],
    browserResolver: async () => browsers,
    fileAccess: async () => {},
    platform: "darwin",
    realpathResolver: async () => "/repo/apps/extension/dist",
    repoRoot: "/repo",
  });

  assert.equal(plan.browsers, browsers);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.extensionPath, "/repo/apps/extension/dist");
  assert.equal(plan.showPopup, false);
});

test("reports a missing unpacked build before browser resolution", async () => {
  let browserResolved = false;

  await assert.rejects(
    createLaunchPlan({
      argv: [],
      browserResolver: async () => {
        browserResolved = true;
        throw new Error("should not run");
      },
      fileAccess: async () => {
        throw new Error("missing");
      },
      platform: "darwin",
      repoRoot: "/repo",
    }),
    /Run npm run build:extension first/u,
  );
  assert.equal(browserResolved, false);
});
