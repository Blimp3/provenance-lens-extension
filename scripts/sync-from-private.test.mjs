import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  EDITION,
  FROM_PRIVATE,
  PUBLIC_OWNED,
  classify,
  guard,
  run,
} from "./sync-from-private.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const git = (root, ...args) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

function write(root, files) {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      rmSync(join(root, path));
      continue;
    }
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

// The index can hold two names that differ only in letter case. A
// case-insensitive file system cannot.
function stage(root, path, content, mode = "100644") {
  const oid = execFileSync(
    "git",
    ["-C", root, "hash-object", "-w", "--stdin"],
    {
      input: content,
      encoding: "utf8",
    },
  ).trim();
  git(root, "update-index", "--add", "--cacheinfo", `${mode},${oid},${path}`);
}

function record(root) {
  git(root, "commit", "-q", "--allow-empty", "-m", "Fixture commit");
  return git(root, "rev-parse", "HEAD");
}

function commit(root, files) {
  write(root, files);
  git(root, "add", "-A");
  return record(root);
}

function repository(context, files) {
  const root = mkdtempSync(join(tmpdir(), "lens-sync-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  // CI has no git identity. A configured one stays, because a commit hook can check it.
  for (const [key, value] of [
    ["user.name", "Fixture"],
    ["user.email", "fixture@example.invalid"],
  ])
    if (spawnSync("git", ["-C", root, "config", key]).status !== 0)
      git(root, "config", key, value);
  commit(root, files);
  return root;
}

const privateFiles = {
  ".gitignore": ".env\n",
  "package.json": '{ "name": "lens" }\n',
  "tsconfig.json": "private line 1\nline 2\n",
  "packages/shared/src/a.ts": "export const a = 1;\n",
  "packages/shared/src/gone.ts": "export const gone = 1;\n",
  "packages/shared/src/old.ts": "export const old = 1;\n",
  "apps/server/fixture.ts": "export const server = 1;\n",
};
const publicFiles = {
  ".gitignore": ".env\noutput/\n",
  ".env": "LOCAL_ONLY=1\n",
  "package.json": '{ "name": "lens-public" }\n',
  "tsconfig.json": "public line 1\nline 2\n",
  "packages/shared/src/a.ts": "export const a = 1;\n",
  "packages/shared/src/gone.ts": "export const gone = 1;\n",
  "packages/shared/src/old.ts": "export const old = 1;\n",
  "README.md": "public\n",
};

function fixture(context) {
  const priv = repository(context, privateFiles);
  const base = git(priv, "rev-parse", "HEAD");
  const pub = repository(context, { ...publicFiles, SOURCE_BASE: `${base}\n` });
  return { priv, pub, base };
}

function call(root, ...argv) {
  const lines = [];
  const original = [console.log, console.error];
  console.log = console.error = (line) => lines.push(String(line));
  try {
    const code = run(root, argv);
    return { code, text: lines.join("\n") };
  } finally {
    [console.log, console.error] = original;
  }
}

const inside = (entry) => (entry.endsWith("/") ? `${entry}x.ts` : entry);

test("the boundary lists are consistent", () => {
  for (const entry of PUBLIC_OWNED) {
    assert.equal(classify(inside(entry)), "public-owned", entry);
    assert.ok(existsSync(join(repositoryRoot, entry)), `${entry} is missing`);
  }
  for (const entry of FROM_PRIVATE) {
    const kind = EDITION.includes(entry) ? "edition" : "mirror";
    assert.equal(classify(inside(entry)), kind, entry);
    assert.ok(existsSync(join(repositoryRoot, entry)), `${entry} is missing`);
  }
  for (const path of EDITION) {
    assert.equal(classify(path), "edition", path);
    assert.ok(existsSync(join(repositoryRoot, path)), `${path} is missing`);
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

test("guard rejects a link or submodule at a path from the private repository", (context) => {
  const root = repository(context, {
    ...publicFiles,
    "README.md": "apps/worker stays private.\n",
  });
  symlinkSync(
    "../../../apps/worker/src/token.ts",
    join(root, "packages/shared/src/token.ts"),
  );
  symlinkSync("../../README.md", join(root, "packages/shared/readme.md"));
  git(root, "add", "-A");
  const head = git(root, "rev-parse", "HEAD");
  git(
    root,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${head},packages/shared/vendor`,
  );
  mkdirSync(join(root, "packages/shared/vendor"));
  assert.deepEqual(guard(root), [
    "link or submodule at a path from the private repository: packages/shared/readme.md",
    "link or submodule at a path from the private repository: packages/shared/src/token.ts",
    "link or submodule at a path from the private repository: packages/shared/vendor",
  ]);
});

test("verify passes on a synced tree and names each difference", (context) => {
  const { priv, pub, base } = fixture(context);
  assert.deepEqual(call(pub, "verify", priv, "HEAD"), {
    code: 0,
    text: `Verified: the public HEAD equals sync(${base.slice(0, 7)}). 3 mirror files are byte-identical. 3 edition files have no private change after SOURCE_BASE.`,
  });

  const deleted = commit(priv, { "packages/shared/src/gone.ts": null });
  commit(pub, { "packages/shared/src/gone.ts": null });
  assert.deepEqual(call(pub, "verify", priv, deleted), {
    code: 0,
    text: `Verified: the public HEAD equals sync(${deleted.slice(0, 7)}). 2 mirror files are byte-identical. 3 edition files have no private change after SOURCE_BASE.`,
  });

  const next = commit(priv, {
    "packages/shared/src/a.ts": "export const a = 2;\n",
    "packages/shared/src/new.ts": "export const fresh = 1;\n",
    "packages/shared/src/old.ts": null,
    "tsconfig.json": "private line 1\nline 2 changed\n",
    "apps/server/fixture.ts": "export const server = 2;\n",
  });
  assert.deepEqual(call(pub, "verify", priv, next), {
    code: 1,
    text: [
      "copy     packages/shared/src/a.ts",
      "add      packages/shared/src/new.ts",
      "delete   packages/shared/src/old.ts",
      "merge    tsconfig.json",
      "",
      `Not in sync: 4 paths differ from sync(${next.slice(0, 7)}).`,
    ].join("\n"),
  });

  const later = commit(priv, { ".gitignore": publicFiles[".gitignore"] });
  commit(pub, {
    "packages/shared/src/a.ts": "export const a = 3;\n",
    "packages/shared/src/extra.ts": "export const extra = 1;\n",
    "tsconfig.json": privateFiles["tsconfig.json"],
  });
  const edited = call(pub, "verify", priv, later);
  assert.equal(edited.code, 2, edited.text);
  for (const blocked of [
    /^BLOCKED {2}\.gitignore: EDITION path equals the private file/mu,
    /^BLOCKED {2}packages\/shared\/src\/a\.ts: the public file differs from the private base/mu,
    /^BLOCKED {2}packages\/shared\/src\/extra\.ts: public-only file in a private folder/mu,
    /^BLOCKED {2}tsconfig\.json: EDITION path equals the private file/mu,
  ])
    assert.match(edited.text, blocked);
});

test("verify refuses a missing base, a base that is not an ancestor and an unknown commit", (context) => {
  const { priv, pub, base } = fixture(context);
  const refused = (pattern, commitName = "HEAD") => {
    const result = call(pub, "verify", priv, commitName);
    assert.equal(result.code, 2, result.text);
    assert.match(result.text, pattern);
  };
  refused(
    /The private clone has no commit no-such-branch\./u,
    "no-such-branch",
  );

  const next = commit(priv, {
    "packages/shared/src/a.ts": "export const a = 2;\n",
  });
  commit(pub, { SOURCE_BASE: `${next}\n` });
  refused(/is not an ancestor of/u, base);

  commit(pub, { SOURCE_BASE: `${"1".repeat(40)}\n` });
  refused(/does not hold the base 1{40}/u);
  commit(pub, { SOURCE_BASE: "main\n" });
  refused(/SOURCE_BASE must hold one full private commit id/u);
  commit(pub, { SOURCE_BASE: null });
  refused(/This checkout has no SOURCE_BASE/u);
});

test("verify leaves the public index unchanged", (context) => {
  const { priv, pub } = fixture(context);
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(pub, "README.md"), later, later);
  const index = readFileSync(join(pub, ".git/index"));
  assert.equal(call(pub, "verify", priv, "HEAD").code, 0);
  assert.ok(
    readFileSync(join(pub, ".git/index")).equals(index),
    "verify rewrote the public index",
  );
});

test("verify refuses a dirty folder and local work that git status hides", (context) => {
  const { priv, pub } = fixture(context);
  const verify = () => call(pub, "verify", priv, "HEAD");
  const dirty =
    /The public working folder is not clean\. Commit or stash first\./u;

  write(pub, { "notes/draft.txt": "draft\n" });
  assert.match(verify().text, dirty);
  git(pub, "config", "status.showUntrackedFiles", "no");
  assert.equal(verify().code, 2);
  write(pub, { "notes/draft.txt": null });
  assert.equal(verify().code, 0);

  git(pub, "update-index", "--assume-unchanged", "README.md");
  write(pub, { "README.md": "local work\n" });
  assert.equal(git(pub, "status", "--porcelain"), "");
  assert.match(verify().text, /hides local work in README\.md/u);
  git(pub, "update-index", "--no-assume-unchanged", "README.md");
  git(pub, "checkout", "--", "README.md");

  git(pub, "update-index", "--skip-worktree", "packages/shared/src/a.ts");
  assert.match(
    verify().text,
    /hides local work in packages\/shared\/src\/a\.ts/u,
  );
});

test("verify blocks a never-published name, a link and two paths that differ only in letter case", (context) => {
  const { priv, pub } = fixture(context);
  stage(priv, "packages/shared/.Dev.Vars", "x\n");
  stage(priv, "packages/shared/src/link.ts", "../../../.env", "120000");
  const never = call(pub, "verify", priv, record(priv));
  assert.equal(never.code, 2, never.text);
  assert.match(
    never.text,
    /^BLOCKED {2}packages\/shared\/\.Dev\.Vars: the private commit tracks a name that is never published$/mu,
  );
  assert.match(
    never.text,
    /^BLOCKED {2}packages\/shared\/src\/link\.ts: the private commit holds a link or submodule \(mode 120000\)$/mu,
  );

  git(priv, "update-index", "--force-remove", "packages/shared/.Dev.Vars");
  git(priv, "update-index", "--force-remove", "packages/shared/src/link.ts");
  stage(priv, "packages/shared/src/A.ts", "export const a = 1;\n");
  const collision = call(pub, "verify", priv, record(priv));
  assert.equal(collision.code, 2, collision.text);
  assert.match(
    collision.text,
    /^BLOCKED {2}packages\/shared\/src\/a\.ts: differs only in letter case from packages\/shared\/src\/A\.ts\./mu,
  );

  git(priv, "update-index", "--force-remove", "packages/shared/src/a.ts");
  const rename = call(pub, "verify", priv, record(priv));
  assert.equal(rename.code, 1, rename.text);
  assert.match(rename.text, /^add {6}packages\/shared\/src\/A\.ts$/mu);
  assert.match(rename.text, /^delete {3}packages\/shared\/src\/a\.ts$/mu);
});
