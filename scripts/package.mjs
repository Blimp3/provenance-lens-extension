import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ZipArchive } from "archiver";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function validatePackageInputs({ rootDirectory = root } = {}) {
  const rootPackage = JSON.parse(
    await readFile(resolve(rootDirectory, "package.json"), "utf8"),
  );
  if (
    typeof rootPackage.version !== "string" ||
    rootPackage.version.length === 0
  ) {
    throw new Error("The root package must declare a non-empty version.");
  }

  const extensionDirectory = resolve(rootDirectory, "apps/extension/dist");
  const outputPath = resolve(
    rootDirectory,
    "artifacts",
    `provenance-lens-extension-v${rootPackage.version}-public.zip`,
  );
  await stat(resolve(extensionDirectory, "manifest.json"));
  let buildProfile;
  try {
    buildProfile = JSON.parse(
      await readFile(resolve(extensionDirectory, "build-profile.json"), "utf8"),
    );
  } catch {
    throw new Error(
      "The public extension build profile is missing or invalid.",
    );
  }
  if (buildProfile?.profile !== "public")
    throw new Error("Refusing to package a non-public extension build.");
  await stat(resolve(extensionDirectory, "THIRD_PARTY_NOTICES.txt"));
  await stat(resolve(extensionDirectory, "LICENSE"));
  return { extensionDirectory, outputPath };
}

export async function packageExtension(options = {}) {
  const { extensionDirectory, outputPath } =
    await validatePackageInputs(options);
  const outputDirectory = dirname(outputPath);
  await mkdir(outputDirectory, { recursive: true });
  await rm(outputPath, { force: true });

  const output = createWriteStream(outputPath, { flags: "wx" });
  const archive = new ZipArchive({ zlib: { level: 9 } });

  const completion = new Promise((resolvePromise, rejectPromise) => {
    output.on("close", resolvePromise);
    output.on("error", rejectPromise);
    archive.on("error", rejectPromise);
    archive.on("warning", (error) => {
      if (error.code === "ENOENT") return;
      rejectPromise(error);
    });
  });

  archive.pipe(output);
  archive.directory(extensionDirectory, false);
  await archive.finalize();
  await completion;

  console.log(`Created ${outputPath} (${archive.pointer()} bytes)`);
  return outputPath;
}

const isDirectRun =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  packageExtension().catch((error) => {
    const message =
      error instanceof Error ? error.message : "Extension packaging failed.";
    console.error(`Extension packaging: ${message}`);
    process.exitCode = 1;
  });
}
