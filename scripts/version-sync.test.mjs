import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path) =>
  JSON.parse(readFileSync(resolve(root, path), "utf8"));

const rootPackage = readJson("package.json");
const lock = readJson("package-lock.json");
const manifest = readJson("apps/extension/manifest.json");
const version = rootPackage.version;
const workspaces = globSync(
  rootPackage.workspaces.map((pattern) => `${pattern}/package.json`),
  { cwd: root },
)
  .map((path) => dirname(path))
  .sort();
const workspacePackages = workspaces.map((path) => ({
  path,
  json: readJson(`${path}/package.json`),
}));

test("the lockfile lists exactly the root workspaces", () => {
  assert.ok(workspaces.length > 0, "no workspaces found");
  const lockWorkspaces = Object.keys(lock.packages)
    .filter((key) => key !== "" && !key.split("/").includes("node_modules"))
    .sort();
  assert.deepEqual(lockWorkspaces, workspaces);
});

test("package.json files, the lockfile and the manifest share one version", () => {
  const sources = [
    ["package-lock.json", lock.version],
    ['package-lock.json packages[""]', lock.packages[""]?.version],
    ["apps/extension/manifest.json", manifest.version],
  ];
  for (const { path, json } of workspacePackages) {
    sources.push([`${path}/package.json`, json.version]);
    sources.push([
      `package-lock.json packages["${path}"]`,
      lock.packages[path]?.version,
    ]);
  }

  const mismatches = sources
    .filter(([, actual]) => actual !== version)
    .map(([source, actual]) => `${source}: ${actual}`);
  assert.deepEqual(mismatches, [], `expected every version to be ${version}`);
});

test("workspace dependencies pin the shared version exactly", () => {
  const names = new Set(workspacePackages.map(({ json }) => json.name));
  const fields = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ];
  const pins = [];
  for (const { path, json } of workspacePackages) {
    for (const [source, entry] of [
      [`${path}/package.json`, json],
      [`package-lock.json packages["${path}"]`, lock.packages[path]],
    ]) {
      for (const field of fields) {
        for (const [name, spec] of Object.entries(entry?.[field] ?? {})) {
          if (names.has(name)) pins.push({ source, name, spec });
        }
      }
    }
  }

  assert.ok(
    pins.some(({ name }) => name === "@provenance-lens/shared"),
    "expected at least one @provenance-lens/shared pin",
  );
  const mismatches = pins
    .filter(({ spec }) => spec !== version)
    .map(({ source, name, spec }) => `${source} ${name}: ${spec}`);
  assert.deepEqual(mismatches, [], `expected every pin to be ${version}`);
});
