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
  "SOURCE_BASE",
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

/**
 * The FROM_PRIVATE files whose public bytes differ on purpose. The difference
 * lives in the public file. Every other FROM_PRIVATE file is a mirror and
 * equals the private file byte for byte.
 */
export const EDITION = [
  ".gitignore",
  "apps/extension/e2e/popup.smoke.spec.ts",
  "apps/extension/manifest.json",
  "apps/extension/package.json",
  "apps/extension/public/settings.html",
  "apps/extension/scripts/build.mjs",
  "apps/extension/src/ui/settings.ts",
  "apps/extension/tests/unit/bundled-client.test.ts",
  "apps/extension/tests/unit/storage.test.ts",
  "package-lock.json",
  "package.json",
  "packages/shared/package.json",
  "packages/shared/src/constants.ts",
  "packages/shared/tests/integration-api.test.ts",
  "scripts/audit-extension.mjs",
  "scripts/package.mjs",
  "scripts/scan-extension.mjs",
  "tsconfig.json",
  "vitest.config.ts",
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

/** @returns {"public-owned" | "edition" | "mirror" | null} null: outside the publication boundary */
export function classify(path) {
  if (
    path.split("/").some((part) => BAD_PART.test(part)) ||
    NEVER_PUBLISHED.test(path)
  )
    return null;
  if (inList(PUBLIC_OWNED, path)) return "public-owned";
  if (!inList(FROM_PRIVATE, path)) return null;
  return EDITION.includes(path) ? "edition" : "mirror";
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

class Refusal extends Error {}

const short = (id) => id.slice(0, 7);

function readBase(root) {
  let text;
  try {
    text = readFileSync(join(root, "SOURCE_BASE"), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Refusal(
      "This checkout has no SOURCE_BASE. Its line 1 names the private commit that the public tree holds.",
    );
  }
  const base = text.trim();
  if (!/^[0-9a-f]{40}$/u.test(base))
    throw new Refusal("SOURCE_BASE must hold one full private commit id.");
  return base;
}

function readTree(repo, commit, pathspecs = []) {
  const tree = new Map();
  const listed = git(repo, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    commit,
    "--",
    ...pathspecs,
  ]);
  for (const record of listed.toString("utf8").split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    const [mode, , oid] = record.slice(0, tab).split(" ");
    tree.set(record.slice(tab + 1), { mode, oid });
  }
  return tree;
}

const same = (a, b) => a?.oid === b?.oid && a?.mode === b?.mode;

function plan({ pub, base, next }) {
  const steps = [];
  const blocks = [];
  const verified = { mirror: 0, edition: 0 };
  const paths = new Set([...pub.keys(), ...base.keys(), ...next.keys()]);
  for (const path of [...paths].sort()) {
    const kind = classify(path);
    const [ours, was, now] = [pub.get(path), base.get(path), next.get(path)];
    const block = (problem) => blocks.push({ path, problem });
    if (kind === "public-owned") continue;
    if (kind === null) {
      if (ours) block("path outside the publication boundary");
      // base and next hold FROM_PRIVATE paths only, so a private path that
      // classify refuses is a never-published name or an unsafe path part.
      else if (now)
        block("the private commit tracks a name that is never published");
    } else if (now && now.mode !== "100644" && now.mode !== "100755") {
      block(`the private commit holds a link or submodule (mode ${now.mode})`);
    } else if (ours && !was && !now) {
      block("public-only file in a private folder. List it in PUBLIC_OWNED");
    } else if (kind === "mirror") {
      if (same(ours, now)) {
        if (ours) verified.mirror += 1;
      } else if (same(ours, was)) {
        steps.push({ path, action: !now ? "delete" : ours ? "copy" : "add" });
      } else {
        block(
          "the public file differs from the private base. Make the change in private, or list the path in EDITION",
        );
      }
    } else if (!ours) {
      block("EDITION path is missing in the public tree");
    } else if (same(ours, was) || same(ours, now)) {
      block("EDITION path equals the private file. Remove it from EDITION");
    } else if (same(was, now)) {
      verified.edition += 1;
    } else {
      steps.push({ path, action: "merge" });
    }
  }
  const final = new Set(pub.keys());
  for (const { path, action } of steps)
    if (action === "delete") final.delete(path);
    else final.add(path);
  blocks.push(...caseFindings(final));
  return { steps, blocks, verified };
}

function verify(root, privateRepo, privateCommit) {
  const recorded = readBase(root);
  const commitId = (name, missing) => {
    try {
      return git(privateRepo, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${name}^{commit}`,
      ])
        .toString("utf8")
        .trim();
    } catch {
      throw new Refusal(missing);
    }
  };
  const target = commitId(
    privateCommit,
    `The private clone has no commit ${privateCommit}.`,
  );
  const base = commitId(
    recorded,
    `The private clone does not hold the base ${recorded}. Fetch the full history (no shallow clone).`,
  );
  try {
    git(privateRepo, ["merge-base", "--is-ancestor", base, target]);
  } catch {
    throw new Refusal(
      `The base ${short(base)} is not an ancestor of ${short(target)}. The tool does not sync backwards.`,
    );
  }
  // The lists and SOURCE_BASE come from the working folder, and the proof is
  // about HEAD.
  const status = git(root, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]);
  if (status.length > 0)
    throw new Refusal(
      "The public working folder is not clean. Commit or stash first.",
    );
  const hidden = git(root, ["ls-files", "-v", "-z"])
    .toString("utf8")
    .split("\0")
    .find((entry) => /^[a-zS] /u.test(entry));
  if (hidden)
    throw new Refusal(
      `The public index hides local work in ${hidden.slice(2)} (assume-unchanged or skip-worktree). Clear the mark first.`,
    );

  const pathspecs = FROM_PRIVATE.map((entry) => entry.replace(/\/$/u, ""));
  const { steps, blocks, verified } = plan({
    pub: readTree(root, "HEAD"),
    base: readTree(privateRepo, base, pathspecs),
    next: readTree(privateRepo, target, pathspecs),
  });
  for (const { path, action } of steps)
    console.log(`${action.padEnd(8)} ${path}`);
  for (const { path, problem } of blocks)
    console.log(`BLOCKED  ${path}: ${problem}`);
  if (blocks.length > 0) {
    console.log(
      `\n${blocks.length} blocked. Fix the lists or the public tree first.`,
    );
    return 2;
  }
  if (steps.length > 0) {
    console.log(
      `\nNot in sync: ${steps.length} paths differ from sync(${short(target)}).`,
    );
    return 1;
  }
  console.log(
    `Verified: the public HEAD equals sync(${short(target)}). ${verified.mirror} mirror files are byte-identical. ${verified.edition} edition files have no private change after SOURCE_BASE.`,
  );
  return 0;
}

const usage = [
  "usage: node scripts/sync-from-private.mjs guard",
  "       node scripts/sync-from-private.mjs verify <private-clone> <private-commit>",
].join("\n");

/** Runs one command and prints its result. @returns {0 | 1 | 2} the exit code */
export function run(root, [command, ...rest]) {
  try {
    if (command === "verify" && rest.length === 2) return verify(root, ...rest);
    if (command !== "guard" || rest.length > 0) throw new Refusal(usage);
    const findings = guard(root);
    for (const finding of findings) console.error(finding);
    if (findings.length > 0) return 1;
    console.log(
      "Path guard passed: every file is inside the publication boundary.",
    );
    return 0;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    console.error(error.message);
    return 2;
  }
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
