import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
    for (const match of contents.toString("utf8").matchAll(workersDevHost)) {
      const hostname = match[0].toLowerCase();
      if (!allowedWorkersDevHosts.has(hostname)) {
        findings.push(`unapproved workers.dev host ${hostname} in ${path}`);
      }
    }
  }

  await visit(directory);
  return findings;
}

const isDirectRun =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
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
