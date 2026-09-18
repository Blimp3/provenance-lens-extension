import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(root, "apps/extension/dist/manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

const expectedPermissions = [
  "activeTab",
  "contextMenus",
  "scripting",
  "storage",
].sort();
const actualPermissions = [...(manifest.permissions ?? [])].sort();
const expectedOptionalHosts = ["http://*/*", "https://*/*"].sort();
const expectedRequiredHosts = [
  "https://private-media-downloader.yellow-salad-bfde.workers.dev/*",
].sort();
const actualRequiredHosts = [...(manifest.host_permissions ?? [])].sort();
const actualOptionalHosts = [
  ...(manifest.optional_host_permissions ?? []),
].sort();
const failures = [];

if (manifest.manifest_version !== 3)
  failures.push("manifest_version must be 3");
if (JSON.stringify(actualPermissions) !== JSON.stringify(expectedPermissions)) {
  failures.push(
    `permissions must be exactly ${expectedPermissions.join(", ")}`,
  );
}
if (
  JSON.stringify(manifest.optional_permissions ?? []) !==
  JSON.stringify(["downloads"])
) {
  failures.push("downloads must be the only optional named permission");
}
if (
  JSON.stringify(actualOptionalHosts) !== JSON.stringify(expectedOptionalHosts)
) {
  failures.push("optional host permissions must be HTTP(S) patterns only");
}
if (
  JSON.stringify(actualRequiredHosts) !== JSON.stringify(expectedRequiredHosts)
) {
  failures.push(
    `host_permissions must be exactly ${expectedRequiredHosts.join(", ")}`,
  );
}
if (manifest.externally_connectable)
  failures.push("externally_connectable is not allowed");
if (manifest.content_scripts)
  failures.push("persistent content scripts are not allowed");

const command = manifest.commands?.["pick-image"];
if (command?.suggested_key?.default !== "Alt+Shift+V") {
  failures.push("pick-image must suggest Alt+Shift+V");
}

if (failures.length > 0) {
  console.error("Extension manifest audit failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Extension manifest audit passed: ${manifestPath}`);
}
