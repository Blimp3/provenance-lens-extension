import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The publication boundary. An entry that ends with "/" is a whole folder.
// Every other entry is one file.

/** Written only in this repository. Never taken from the private repository. */
export const PUBLIC_OWNED = [
  "README.md",
  "CHANGELOG.md",
  "CLAUDE.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.txt",
  "SOURCE_PROVENANCE.md",
  "SOURCE_MANIFEST.sha256",
  "docs/",
  ".github/workflows/ci.yml",
  "scripts/public-package.test.mjs",
  "scripts/sync-from-private.mjs",
  "scripts/sync-from-private.test.mjs",
];

/** Taken from the private repository. No other private path is published. */
export const FROM_PRIVATE = [
  "apps/extension/",
  "packages/shared/",
  ".editorconfig",
  ".gitignore",
  ".npmrc",
  ".nvmrc",
  ".prettierignore",
  "eslint.config.js",
  "package.json",
  "package-lock.json",
  "tsconfig.base.json",
  "tsconfig.json",
  "vitest.config.ts",
  "start-provenance-lens.command",
  "scripts/audit-extension.mjs",
  "scripts/package.mjs",
  "scripts/scan-extension.mjs",
  "scripts/start-extension.mjs",
  "scripts/start-extension.test.mjs",
  "scripts/version-sync.test.mjs",
];

const NEVER_PUBLISHED =
  /(^|\/)(\.env(\..*)?|\.dev\.vars(\..*)?|\.bundled-client[^/]*|wrangler\.(json|jsonc|toml)|[^/]*\.(patch|orig|rej))$/iu;

/** A path part that git or the file system treats specially. */
const BAD_PART = /^(|\.|\.\.|\.git)$/iu;

const PRIVATE_MENTION =
  /\bapps\/(?!extension\b)[a-z][a-z-]*|@provenance-lens\/(?!extension\b|shared\b)[a-z][a-z-]*/gu;

const git = (repo, args) =>
  execFileSync("git", ["-C", repo, ...args], {
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

const inList = (list, path) =>
  list.some((entry) =>
    entry.endsWith("/") ? path.startsWith(entry) : path === entry,
  );

/** @returns {"public-owned" | "mirror" | null} null: outside the publication boundary */
export function classify(path) {
  if (
    path.split("/").some((part) => BAD_PART.test(part)) ||
    NEVER_PUBLISHED.test(path)
  )
    return null;
  if (inList(PUBLIC_OWNED, path)) return "public-owned";
  return inList(FROM_PRIVATE, path) ? "mirror" : null;
}

function mentionFindings(path, text) {
  if (text.includes("\0")) return [];
  return [...text.matchAll(PRIVATE_MENTION)].map(
    (match) =>
      `${path}:${text.slice(0, match.index).split("\n").length}: names private workspace ${match[0]}`,
  );
}

// A case-insensitive volume holds only one of two names that differ only in
// letter case, so such a pair of files or folders cannot be checked out.
function caseFindings(paths) {
  const names = new Map();
  for (const path of paths) {
    const parts = path.split("/");
    for (let end = 1; end <= parts.length; end += 1) {
      const name = parts.slice(0, end).join("/");
      const key = name.toLowerCase();
      if (!names.has(key)) names.set(key, new Set());
      names.get(key).add(name);
    }
  }
  return [...names.values()].flatMap((spellings) => {
    const [first, ...others] = [...spellings].sort();
    return others.map((path) => ({
      path,
      problem: `differs only in letter case from ${first}. Rename it in the private repository and in this repository first`,
    }));
  });
}

/** @returns {string[]} one line for each problem. An empty list means that every file is inside the boundary. */
export function guard(root) {
  const listed = git(root, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  const paths = [
    ...new Set(listed.toString("utf8").split("\0").filter(Boolean)),
  ].sort();
  const findings = [];
  for (const path of paths) {
    const kind = classify(path);
    if (kind === null) {
      findings.push(`path outside the publication boundary: ${path}`);
      continue;
    }
    if (kind === "public-owned") continue;
    let text;
    try {
      text = readFileSync(join(root, path), "utf8");
    } catch (error) {
      // A tracked file deleted from the working folder publishes nothing.
      if (error.code === "ENOENT") continue;
      throw error;
    }
    findings.push(...mentionFindings(path, text));
  }
  for (const { path, problem } of caseFindings(paths))
    findings.push(`${path}: ${problem}`);
  return findings;
}

function run(root, argv) {
  if (argv.length !== 1 || argv[0] !== "guard") {
    console.error("usage: node scripts/sync-from-private.mjs guard");
    return 2;
  }
  const findings = guard(root);
  for (const finding of findings) console.error(finding);
  if (findings.length > 0) return 1;
  console.log(
    "Path guard passed: every file is inside the publication boundary.",
  );
  return 0;
}

const isDirectRun =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  process.exitCode = run(
    resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    process.argv.slice(2),
  );
}
