import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

import { packageExtension, validatePackageInputs } from "./package.mjs";
import { scanExtensionDirectory } from "./scan-extension.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const canaryPrefix = "PUBLIC_PACKAGE_CANARY_";
const canary = `${canaryPrefix}${"A".repeat(64 - canaryPrefix.length)}`;

test("public build and ZIP ignore an owner config canary", async (context) => {
  const root = await createBuildFixture();
  context.after(() => rm(root, { recursive: true, force: true }));

  await runBuild(root);
  const withoutConfig = await snapshotDirectory(
    join(root, "apps/extension/dist"),
  );
  const firstPackage = await packageExtension({ rootDirectory: root });
  assert.equal((await stat(firstPackage)).isFile(), true);

  await writeFile(
    join(root, "apps/extension/.bundled-client.json"),
    `${JSON.stringify({ clientToken: canary })}\n`,
    { mode: 0o600 },
  );
  await runBuild(root);
  const withConfig = await snapshotDirectory(join(root, "apps/extension/dist"));

  assert.deepEqual(withConfig, withoutConfig);
  for (const contents of await readDirectoryFiles(
    join(root, "apps/extension/dist"),
  )) {
    assert.equal(contents.includes(Buffer.from(canary)), false);
  }

  const { outputPath } = await validatePackageInputs({
    rootDirectory: root,
  });
  assert.match(outputPath, /provenance-lens-extension-v0\.8\.0-public\.zip$/u);
  assert.equal(
    JSON.parse(
      await readFile(
        join(root, "apps/extension/dist/build-profile.json"),
        "utf8",
      ),
    ).profile,
    "public",
  );
  assert.equal(
    await readFile(join(root, "apps/extension/dist/LICENSE"), "utf8"),
    await readFile(join(root, "LICENSE"), "utf8"),
  );
  const notices = await readFile(
    join(root, "apps/extension/dist/THIRD_PARTY_NOTICES.txt"),
    "utf8",
  );
  assert.match(notices, /do not license\s+Provenance Lens itself\./u);
  assert.match(notices, /zod 4\.5\.4/u);

  const secondPackage = await packageExtension({ rootDirectory: root });
  assert.equal(secondPackage, firstPackage);
  assert.equal((await stat(secondPackage)).isFile(), true);
});

test("public packaging refuses a personalized build", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "provenance-lens-public-package-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "apps/extension/dist"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"version":"0.8.0"}\n');
  await writeFile(
    join(root, "apps/extension/dist/manifest.json"),
    '{"manifest_version":3}\n',
  );
  await writeFile(
    join(root, "apps/extension/dist/build-profile.json"),
    '{"profile":"personalized"}\n',
  );
  await writeFile(
    join(root, "apps/extension/dist/THIRD_PARTY_NOTICES.txt"),
    "notices\n",
  );

  await assert.rejects(
    validatePackageInputs({ rootDirectory: root }),
    /Refusing to package a non-public extension build/u,
  );
});

test("extension scan permits only the documented workers.dev host", async (context) => {
  const directory = await mkdtemp(
    join(tmpdir(), "provenance-lens-public-scan-"),
  );
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, "allowed.js"),
    'const endpoint = "https://private-media-downloader.yellow-salad-bfde.workers.dev/api/integration";\n',
  );
  assert.deepEqual(await scanExtensionDirectory(directory), []);

  await writeFile(
    join(directory, "rejected.js"),
    'const endpoint = "https://synthetic-verifier.workers.dev/api/verify";\n',
  );
  const findings = await scanExtensionDirectory(directory);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /unapproved workers\.dev host/u);
  assert.match(findings[0], /synthetic-verifier\.workers\.dev/u);
});

async function createBuildFixture() {
  const root = await mkdtemp(join(tmpdir(), "provenance-lens-public-build-"));
  const source = join(repositoryRoot, "apps/extension");
  const target = join(root, "apps/extension");
  await mkdir(join(target, "scripts"), { recursive: true });
  await Promise.all([
    cp(join(source, "src"), join(target, "src"), { recursive: true }),
    cp(join(source, "public"), join(target, "public"), { recursive: true }),
    cp(join(source, "manifest.json"), join(target, "manifest.json")),
    cp(join(source, "scripts/build.mjs"), join(target, "scripts/build.mjs")),
    cp(
      join(repositoryRoot, "THIRD_PARTY_NOTICES.txt"),
      join(root, "THIRD_PARTY_NOTICES.txt"),
    ),
    cp(join(repositoryRoot, "LICENSE"), join(root, "LICENSE")),
  ]);
  await writeFile(join(root, "package.json"), '{"version":"0.8.0"}\n');
  await symlink(
    join(repositoryRoot, "node_modules"),
    join(root, "node_modules"),
  );
  return root;
}

async function runBuild(root) {
  await execFileAsync(
    process.execPath,
    [join(root, "apps/extension/scripts/build.mjs")],
    { cwd: root, maxBuffer: 10 * 1024 * 1024 },
  );
}

async function snapshotDirectory(directory) {
  const snapshot = {};
  for (const path of await listFiles(directory)) {
    snapshot[relative(directory, path)] = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  }
  return snapshot;
}

async function readDirectoryFiles(directory) {
  return Promise.all(
    (await listFiles(directory)).map((path) => readFile(path)),
  );
}

async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}
