import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  FROM_PRIVATE,
  PUBLIC_OWNED,
  classify,
  guard,
} from "./sync-from-private.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const git = (root, ...args) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

function write(root, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

// The index can hold two names that differ only in letter case. A
// case-insensitive file system cannot.
function stage(root, path, content) {
  const oid = execFileSync(
    "git",
    ["-C", root, "hash-object", "-w", "--stdin"],
    {
      input: content,
      encoding: "utf8",
    },
  ).trim();
  git(root, "update-index", "--add", "--cacheinfo", `100644,${oid},${path}`);
}

const publicFiles = {
  ".gitignore": ".env\n",
  ".env": "LOCAL_ONLY=1\n",
  "package.json": "{}\n",
  "packages/shared/src/a.ts": "export const a = 1;\n",
  "README.md": "public\n",
};

function repository(context, files) {
  const root = mkdtempSync(join(tmpdir(), "lens-sync-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  write(root, files);
  git(root, "add", "-A");
  return root;
}

const inside = (entry) => (entry.endsWith("/") ? `${entry}x.ts` : entry);

test("the boundary lists are consistent", () => {
  for (const entry of PUBLIC_OWNED) {
    assert.equal(classify(inside(entry)), "public-owned", entry);
    assert.ok(existsSync(join(repositoryRoot, entry)), `${entry} is missing`);
  }
  for (const entry of FROM_PRIVATE) {
    assert.equal(classify(inside(entry)), "mirror", entry);
    assert.ok(existsSync(join(repositoryRoot, entry)), `${entry} is missing`);
  }
});

test("classify refuses dot parts and every letter case of a never-published name", () => {
  for (const path of [
    "apps/extension/../../README.md",
    "apps/extension/./src/a.ts",
    "apps/extension//src/a.ts",
    "apps/extension/src/",
    "apps/extension/.git/config",
    "packages/shared/.GIT/hooks/pre-commit",
    "apps/extension/.env",
    "apps/extension/.ENV.local",
    "packages/shared/.Dev.Vars",
    "apps/extension/.bundled-client.json",
    "apps/extension/.Bundled-Client.backup.json",
    "apps/extension/Wrangler.jsonc",
    "packages/shared/wrangler.TOML",
    "docs/.env",
    "README.md.patch",
    "apps/extension/src/a.ts.ORIG",
    "packages/shared/src/a.ts.rej",
  ])
    assert.equal(classify(path), null, path);
  assert.equal(classify("apps/extension/src/environment.ts"), "mirror");
  assert.equal(classify("apps/extension/src/bundled-client.ts"), "mirror");
  assert.equal(classify("apps/server/fixture.ts"), null);
  assert.equal(classify("docs/portfolio-demo.md"), "public-owned");
});

test("guard rejects a path outside the boundary", (context) => {
  const root = repository(context, publicFiles);
  assert.deepEqual(guard(root), []);
  write(root, { "apps/server/fixture.ts": "x\n", "README.md.patch": "" });
  assert.deepEqual(guard(root), [
    "path outside the publication boundary: README.md.patch",
    "path outside the publication boundary: apps/server/fixture.ts",
  ]);
});

test("guard rejects a Worker config name and a private workspace mention", (context) => {
  const root = repository(context, publicFiles);
  write(root, {
    "apps/extension/wrangler.jsonc": "{}\n",
    "packages/shared/src/a.ts":
      "// moved here from apps/worker\nexport const a = 1;\n",
    "docs/boundary.md": "apps/worker stays private.\n",
  });
  assert.deepEqual(guard(root), [
    "path outside the publication boundary: apps/extension/wrangler.jsonc",
    "packages/shared/src/a.ts:1: names private workspace apps/worker",
  ]);
});

test("guard rejects two paths that differ only in letter case", (context) => {
  const root = repository(context, publicFiles);
  stage(root, "packages/shared/src/A.ts", "export const a = 1;\n");
  stage(root, "apps/extension/src/Ui/b.ts", "export const b = 1;\n");
  stage(root, "apps/extension/src/ui/c.ts", "export const c = 1;\n");
  const rename =
    "Rename it in the private repository and in this repository first";
  assert.deepEqual(guard(root), [
    `apps/extension/src/ui: differs only in letter case from apps/extension/src/Ui. ${rename}`,
    `packages/shared/src/a.ts: differs only in letter case from packages/shared/src/A.ts. ${rename}`,
  ]);
});
