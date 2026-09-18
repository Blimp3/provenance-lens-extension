import { chromium, expect, test, type Worker } from "@playwright/test";
import { PICKER_RUNTIME_VERSION } from "@provenance-lens/shared";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CANCEL_SESSION_TOKEN = "123e4567-e89b-42d3-a456-426614174000";
const SELECT_SESSION_TOKEN = "223e4567-e89b-42d3-a456-426614174000";

test("activates the bundled picker through extension transport on first and repeated use", async ({
  browserName,
}) => {
  expect(browserName).toBe("chromium");
  const imageBytes = await readFile(
    resolve(process.cwd(), "tests/fixtures/image-fixture.png"),
  );
  const fixtureServer = createServer((request, response) => {
    if (request.url === "/image.png") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(imageBytes);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html lang="en">
        <body style="margin: 0; min-height: 100vh;">
          <a id="image-link" href="/should-not-navigate">
            <img id="target-image" src="/image.png" alt="Fixture" width="320" height="180">
          </a>
          <script>
            window.__hostClickCount = 0;
            document.querySelector('#image-link').addEventListener('click', (event) => {
              window.__hostClickCount += 1;
              event.preventDefault();
            });
          </script>
        </body>
      </html>`);
  });
  fixtureServer.listen(0, "127.0.0.1");
  await once(fixtureServer, "listening");
  const address = fixtureServer.address();
  if (!address || typeof address === "string") {
    throw new Error("The picker fixture server did not start.");
  }

  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "provenance-lens-picker-"),
  );
  const extensionPath = resolve(temporaryRoot, "extension");
  await cp(resolve(process.cwd(), "dist"), extensionPath, { recursive: true });
  const manifestPath = resolve(extensionPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    host_permissions: string[];
  };
  manifest.host_permissions.push("http://127.0.0.1/*");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const context = await chromium.launchPersistentContext(
    resolve(temporaryRoot, "profile"),
    {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    },
  );
  await context.route(/^(?!http:\/\/127\.0\.0\.1:)/u, (route) => route.abort());
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    await installMessageObserver(worker);
    const page = await context.newPage();
    const fixtureUrl = `http://127.0.0.1:${address.port}/fixture.html`;
    await page.goto(fixtureUrl);

    await activatePicker(worker, fixtureUrl, CANCEL_SESSION_TOKEN);
    const overlay = page.locator('[data-provenance-lens-picker="overlay"]');
    await expect(overlay).toHaveCount(1);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.cursor))
      .toBe("crosshair");
    await page.keyboard.press("Escape");
    await expect(overlay).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.cursor))
      .toBe("");
    await expect
      .poll(() => observedMessages(worker, "picker-cancelled"))
      .toHaveLength(1);
    expect((await observedMessages(worker, "picker-cancelled"))[0]).toEqual({
      type: "picker-cancelled",
      sessionToken: CANCEL_SESSION_TOKEN,
    });

    await activatePicker(worker, fixtureUrl, SELECT_SESSION_TOKEN);
    await expect(overlay).toHaveCount(1);
    const image = page.locator("#target-image");
    const imageBox = await image.boundingBox();
    expect(imageBox).not.toBeNull();
    const imageX = (imageBox?.x ?? 0) + 160;
    const imageY = (imageBox?.y ?? 0) + 90;
    await page.mouse.move(imageX, imageY);
    await expect(overlay).toHaveAttribute(
      "aria-label",
      /Image · 320 × 180 px · Click to select · Esc to cancel/u,
    );
    await page.mouse.click(imageX, imageY);
    await expect(overlay).toHaveCount(0);
    await expect(page).toHaveURL(fixtureUrl);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as Window & { __hostClickCount?: number })
              .__hostClickCount ?? 0,
        ),
      )
      .toBe(0);
    await expect
      .poll(() => observedMessages(worker, "picker-selected"))
      .toHaveLength(1);
    expect(
      (await observedMessages(worker, "picker-selected"))[0],
    ).toMatchObject({
      sessionToken: SELECT_SESSION_TOKEN,
      selection: { url: `http://127.0.0.1:${address.port}/image.png` },
    });
  } finally {
    await context.close();
    await new Promise<void>((resolveClose, rejectClose) => {
      fixtureServer.close((error) => {
        if (error) rejectClose(error);
        else resolveClose();
      });
    });
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function activatePicker(
  worker: Worker,
  pageUrl: string,
  sessionToken: string,
): Promise<void> {
  await worker.evaluate(
    async ({ pageUrl, runtimeVersion, sessionToken }) => {
      const [tab] = await chrome.tabs.query({ url: pageUrl });
      if (!tab?.id) throw new Error("The picker fixture tab was not found.");
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["picker.js"],
      });
      if (!injection?.documentId) {
        throw new Error("Picker injection did not return a document ID.");
      }
      const options = { documentId: injection.documentId };
      await chrome.tabs.sendMessage(
        tab.id,
        { type: "page-bind", runtimeVersion, sessionToken },
        options,
      );
      await chrome.tabs.sendMessage(
        tab.id,
        { type: "picker-start", runtimeVersion, sessionToken },
        options,
      );
    },
    { pageUrl, runtimeVersion: PICKER_RUNTIME_VERSION, sessionToken },
  );
}

async function installMessageObserver(worker: Worker): Promise<void> {
  await worker.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      __pickerRuntimeMessages?: unknown[];
    };
    scope.__pickerRuntimeMessages = [];
    chrome.runtime.onMessage.addListener((message: unknown) => {
      scope.__pickerRuntimeMessages?.push(message);
    });
  });
}

async function observedMessages(
  worker: Worker,
  type: "picker-cancelled" | "picker-selected",
): Promise<Array<Record<string, unknown>>> {
  return worker.evaluate((messageType) => {
    const messages = (
      globalThis as typeof globalThis & {
        __pickerRuntimeMessages?: Array<Record<string, unknown>>;
      }
    ).__pickerRuntimeMessages;
    return messages?.filter((message) => message["type"] === messageType) ?? [];
  }, type);
}
