import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import * as esbuild from "esbuild";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(appDir, "src");
const publicDir = join(appDir, "public");
const outputDir = join(appDir, "dist");
const watch = process.argv.includes("--watch");
const bundledClientToken = "";

const entryPoints = {
  background: join(sourceDir, "background.ts"),
  picker: join(sourceDir, "picker.ts"),
  popup: join(sourceDir, "ui/popup.ts"),
  settings: join(sourceDir, "ui/settings.ts"),
  history: join(sourceDir, "ui/history.ts"),
  details: join(sourceDir, "ui/details.ts"),
  disclosure: join(sourceDir, "ui/disclosure.ts"),
  audio: join(sourceDir, "ui/audio.ts"),
};

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await cp(join(publicDir, "styles.css"), join(outputDir, "styles.css"));
await cp(
  join(publicDir, "icons/icon-source.svg"),
  join(outputDir, "icons/icon-source.svg"),
);
await cp(join(appDir, "manifest.json"), join(outputDir, "manifest.json"));
await writeFile(
  join(outputDir, "build-profile.json"),
  `${JSON.stringify({ profile: "public" }, null, 2)}\n`,
);
await cp(
  resolve(appDir, "../..", "THIRD_PARTY_NOTICES.txt"),
  join(outputDir, "THIRD_PARTY_NOTICES.txt"),
);
await cp(resolve(appDir, "../..", "LICENSE"), join(outputDir, "LICENSE"));

for (const page of [
  "popup",
  "settings",
  "history",
  "details",
  "disclosure",
  "audio",
]) {
  await cp(join(publicDir, `${page}.html`), join(outputDir, `${page}.html`));
}

for (const size of [16, 32, 48, 128]) {
  await writeFile(
    join(outputDir, `icons/icon-${size}.png`),
    createIconPng(size),
  );
}

const buildOptions = {
  entryPoints,
  outdir: outputDir,
  bundle: true,
  format: "esm",
  target: "es2022",
  sourcemap: false,
  minify: !watch,
  legalComments: "none",
  treeShaking: true,
  define: {
    __PROVENANCE_LENS_BUNDLED_CLIENT_TOKEN__:
      JSON.stringify(bundledClientToken),
  },
  logLevel: "info",
};

if (watch) {
  const context = await esbuild.context(buildOptions);
  await context.watch();
  console.log("Watching extension sources...");
} else {
  await esbuild.build(buildOptions);
}

function createIconPng(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const center = (size - 1) / 2;
  const radius = size * 0.32;
  const ringWidth = Math.max(1.5, size * 0.07);
  const handleWidth = Math.max(1.5, size * 0.09);
  const corner = size * 0.22;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      const edgeX = Math.min(x, size - 1 - x);
      const edgeY = Math.min(y, size - 1 - y);
      const rounded =
        edgeX >= corner ||
        edgeY >= corner ||
        Math.hypot(corner - edgeX, corner - edgeY) <= corner;
      const distance = Math.hypot(x - center, y - center);
      const ring = Math.abs(distance - radius) <= ringWidth;
      const handle =
        x > center + radius * 0.56 &&
        x < center + radius * 1.58 &&
        Math.abs(y - x) <= handleWidth;
      const cross =
        (Math.abs(x - center) <= Math.max(1, size * 0.035) &&
          Math.abs(y - center) <= radius * 0.42) ||
        (Math.abs(y - center) <= Math.max(1, size * 0.035) &&
          Math.abs(x - center) <= radius * 0.42);

      if (!rounded) {
        pixels[index + 3] = 0;
      } else if (ring || handle) {
        pixels[index] = 82;
        pixels[index + 1] = 82;
        pixels[index + 2] = 91;
        pixels[index + 3] = 255;
      } else if (cross) {
        pixels[index] = 24;
        pixels[index + 1] = 24;
        pixels[index + 2] = 27;
        pixels[index + 3] = 255;
      } else {
        pixels[index] = 244;
        pixels[index + 1] = 244;
        pixels[index + 2] = 245;
        pixels[index + 3] = 255;
      }
    }
  }

  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const chunks = [
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ];
  return Buffer.concat([signature, ...chunks]);
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), data.length + 8);
  return chunk;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
