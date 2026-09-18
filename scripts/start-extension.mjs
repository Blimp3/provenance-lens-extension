#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SUPPORTED_BROWSERS = new Set(["auto", "all", "brave-origin", "chrome"]);

const MAC_BROWSER_DEFINITIONS = {
  "brave-origin": {
    applicationName: "Brave Origin",
    applicationPath: "/Applications/Brave Origin.app",
    executable: "/Applications/Brave Origin.app/Contents/MacOS/Brave Origin",
    extensionsUrl: "brave://extensions/",
    name: "brave-origin",
  },
  chrome: {
    applicationName: "Google Chrome",
    applicationPath: "/Applications/Google Chrome.app",
    executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    extensionsUrl: "chrome://extensions/",
    name: "chrome",
  },
};

const HELP_TEXT = `Start the browsers where Provenance Lens was manually installed.

Usage:
  npm run start:extension
  npm run start:extension -- --browser chrome
  npm run start:extension -- --browser all

Options:
  --browser <name>  auto, brave-origin, chrome, or all
  --show-popup      Open the Provenance Lens popup page in a browser tab
  --dry-run         Print the resolved launch plan without opening a browser
  -h, --help        Show this help

The default is Brave Origin. The launcher starts or activates the browser's
existing signed-in profile; it never creates a separate profile and never
changes extension settings. Chromium requires a user to approve installation
or re-enabling from the browser's Extensions page.`;

function takeOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

export function parseArguments(argv) {
  const options = {
    browser: "auto",
    dryRun: false,
    help: false,
    showPopup: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (argument === "--show-popup") {
      options.showPopup = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--browser") {
      options.browser = takeOptionValue(argv, index, "--browser");
      index += 1;
      continue;
    }
    if (argument.startsWith("--browser=")) {
      options.browser = argument.slice("--browser=".length);
      continue;
    }

    throw new Error(`Unknown option: ${argument}`);
  }

  if (!SUPPORTED_BROWSERS.has(options.browser)) {
    if (options.browser === "brave") {
      throw new Error(
        "Normal Brave is intentionally excluded. Use brave-origin, chrome, or all.",
      );
    }
    throw new Error(
      `Unsupported browser: ${options.browser}. Use auto, brave-origin, chrome, or all.`,
    );
  }

  return options;
}

export function deriveExtensionId(extensionPath) {
  const digest = createHash("sha256").update(extensionPath).digest();
  let extensionId = "";

  for (const byte of digest.subarray(0, 16)) {
    extensionId += String.fromCharCode(97 + (byte >> 4));
    extensionId += String.fromCharCode(97 + (byte & 0x0f));
  }

  return extensionId;
}

async function isExecutable(path) {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveBrowsers(
  browserName,
  platform = process.platform,
  executableCheck = isExecutable,
) {
  if (platform !== "darwin") {
    throw new Error("The automatic launcher currently supports macOS only.");
  }

  const candidateNames =
    browserName === "auto"
      ? ["brave-origin", "chrome"]
      : browserName === "all"
        ? ["brave-origin", "chrome"]
        : [browserName];
  const browsers = [];

  for (const candidateName of candidateNames) {
    const definition = MAC_BROWSER_DEFINITIONS[candidateName];
    if (definition && (await executableCheck(definition.executable))) {
      browsers.push(definition);
      if (browserName === "auto") {
        break;
      }
    } else if (browserName !== "auto" && browserName !== "all") {
      throw new Error(
        `${definition?.applicationName ?? candidateName} is not installed.`,
      );
    }
  }

  if (browsers.length === 0) {
    throw new Error("Neither Brave Origin nor Google Chrome is installed.");
  }

  return browsers;
}

export function findBrowserPid(processList, executable) {
  for (const line of processList.split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    if (!match) {
      continue;
    }

    const command = match[2];
    if (command === executable || command.startsWith(`${executable} --`)) {
      return Number(match[1]);
    }
  }

  return undefined;
}

export async function createLaunchPlan({
  argv = process.argv.slice(2),
  browserResolver = resolveBrowsers,
  fileAccess = access,
  platform = process.platform,
  realpathResolver = realpath,
  repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
} = {}) {
  const options = parseArguments(argv);
  if (options.help) {
    return { help: true };
  }

  const manifestPath = join(
    repoRoot,
    "apps",
    "extension",
    "dist",
    "manifest.json",
  );
  try {
    await fileAccess(manifestPath, fsConstants.R_OK);
  } catch {
    throw new Error(
      `The unpacked extension is not built at ${manifestPath}. Run npm run build:extension first.`,
    );
  }

  const extensionPath = await realpathResolver(dirname(manifestPath));
  const extensionId = deriveExtensionId(extensionPath);
  const browsers = await browserResolver(options.browser, platform);

  return {
    browsers,
    dryRun: options.dryRun,
    extensionId,
    extensionPath,
    help: false,
    manifestPath,
    popupUrl: `chrome-extension://${extensionId}/popup.html`,
    showPopup: options.showPopup,
  };
}

function readProcessList() {
  const result = spawnSync("/bin/ps", ["-ww", "-axo", "pid=,command="], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error("Could not inspect running browser processes.");
  }
  return result.stdout;
}

function openApplication(browser, url) {
  const argumentsList = ["-a", browser.applicationPath];
  if (url) {
    argumentsList.push(url);
  }
  const result = spawnSync("/usr/bin/open", argumentsList, { stdio: "ignore" });
  if (result.status !== 0) {
    throw new Error(`Could not open ${browser.applicationName}.`);
  }
}

async function waitForBrowser(executable, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const pid = findBrowserPid(readProcessList(), executable);
    if (pid) {
      return pid;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  return undefined;
}

export async function runLauncher(argv = process.argv.slice(2)) {
  const plan = await createLaunchPlan({ argv });
  if (plan.help) {
    console.log(HELP_TEXT);
    return { status: "help" };
  }

  if (plan.dryRun) {
    console.log(
      JSON.stringify(
        {
          browsers: plan.browsers.map((browser) => ({
            applicationName: browser.applicationName,
            applicationPath: browser.applicationPath,
            executable: browser.executable,
            extensionsUrl: browser.extensionsUrl,
          })),
          extensionId: plan.extensionId,
          extensionPath: plan.extensionPath,
          popupUrl: plan.popupUrl,
          showPopup: plan.showPopup,
        },
        null,
        2,
      ),
    );
    return { plan, status: "dry-run" };
  }

  const results = [];
  for (const browser of plan.browsers) {
    const existingPid = findBrowserPid(readProcessList(), browser.executable);
    openApplication(browser, plan.showPopup ? plan.popupUrl : undefined);
    const pid = existingPid ?? (await waitForBrowser(browser.executable));
    if (!pid) {
      throw new Error(`${browser.applicationName} did not start.`);
    }

    const status = existingPid ? "already-active" : "started";
    console.log(
      `${browser.applicationName}: ${status === "started" ? "started" : "already active"} (PID ${pid}).`,
    );
    results.push({ browser: browser.name, pid, status });
  }

  console.log(`Provenance Lens build: ${plan.extensionPath}`);
  console.log(`Expected unpacked extension ID: ${plan.extensionId}`);
  console.log(
    "If a browser has disabled or not installed it, use that browser's Extensions page and choose Load unpacked; Chromium requires your approval.",
  );
  return { results, status: "complete" };
}

const isDirectRun =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  runLauncher().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Provenance Lens launcher: ${message}`);
    process.exitCode = 1;
  });
}
