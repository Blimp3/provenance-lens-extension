import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionDirectory = resolve(root, "apps/extension/dist");
const forbidden = [
  "sk-",
  "OPENAI_API_KEY",
  "api.openai.com",
  "PUBLIC_PACKAGE_CANARY_",
];
const allowedWorkersDevHosts = new Set([
  "private-media-downloader.yellow-salad-bfde.workers.dev",
]);
const workersDevHost =
  /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+workers\.dev\b/giu;
// Tracked-source rules. The bare "sk-" needle stays build-only because source
// legitimately mentions the prefix; a key needs the long suffix.
const sourceRules = [
  { label: "local user path", pattern: /\/Users\/(?!example\/)[^\s"'`]*/gu },
  { label: "local home path", pattern: /\/home\/[^\s"'`]*/gu },
  {
    label: "provider-key-shaped string",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/gu,
    redact: true,
  },
];
// These two contain every needle on purpose: the rules above and the
// scanner's own test fixtures.
const sourceScanExclusions = new Set([
  "scripts/scan-extension.mjs",
  "scripts/public-package.test.mjs",
]);

function unapprovedWorkersDevHosts(text) {
  const findings = [];
  for (const match of text.matchAll(workersDevHost)) {
    const hostname = match[0].toLowerCase();
    if (!allowedWorkersDevHosts.has(hostname)) {
      findings.push(`unapproved workers.dev host ${hostname}`);
    }
  }
  return findings;
}

export async function scanExtensionDirectory(directory) {
  const findings = [];

  async function visit(path) {
    const metadata = await stat(path);
    if (metadata.isDirectory()) {
      const names = await readdir(path);
      await Promise.all(names.map((name) => visit(resolve(path, name))));
      return;
    }

    const contents = await readFile(path);
    for (const needle of forbidden) {
      if (contents.includes(Buffer.from(needle))) {
        findings.push(`${needle} in ${path}`);
      }
    }
    for (const finding of unapprovedWorkersDevHosts(
      contents.toString("utf8"),
    )) {
      findings.push(`${finding} in ${path}`);
    }
  }

  await visit(directory);
  return findings;
}

export async function scanSourceFiles(repositoryRoot = root) {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z"], {
    cwd: repositoryRoot,
    maxBuffer: 10 * 1024 * 1024,
  });
  const files = stdout
    .split("\0")
    .filter((file) => file !== "" && !sourceScanExclusions.has(file));
  const findings = [];

  for (const file of files) {
    const text = await readFile(resolve(repositoryRoot, file), "utf8");
    for (const finding of unapprovedWorkersDevHosts(text)) {
      findings.push(`${finding} in ${file}`);
    }
    for (const { label, pattern, redact } of sourceRules) {
      for (const match of text.matchAll(pattern)) {
        const line = text.slice(0, match.index).split("\n").length;
        const detail = redact ? "" : ` ${match[0]}`;
        findings.push(`${label}${detail} in ${file}:${line}`);
      }
    }
  }

  return { files, findings };
}

const isDirectRun =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectRun && process.argv.includes("--source")) {
  const { files, findings } = await scanSourceFiles();
  if (findings.length > 0) {
    console.error("Forbidden tracked-source content found:");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exitCode = 1;
  } else {
    console.log(
      `Source scan passed: ${sourceRules.map((rule) => rule.label).join(", ")} and unapproved workers.dev hosts were not found in ${files.length} tracked files.`,
    );
  }
} else if (isDirectRun) {
  const findings = await scanExtensionDirectory(extensionDirectory);
  if (findings.length > 0) {
    console.error("Forbidden extension-build content found:");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exitCode = 1;
  } else {
    console.log(
      `Extension scan passed: ${forbidden.join(", ")} and unapproved workers.dev hosts were not found in ${extensionDirectory}.`,
    );
  }
}
