import {
  chromium,
  expect,
  test,
  type CDPSession,
  type Page,
  type Worker,
} from "@playwright/test";
import { PICKER_RUNTIME_VERSION } from "@provenance-lens/shared";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CANCEL_SESSION_TOKEN = "123e4567-e89b-42d3-a456-426614174000";
const SELECT_SESSION_TOKEN = "223e4567-e89b-42d3-a456-426614174000";
const ARMED_SESSION_TOKEN = "423e4567-e89b-42d3-a456-426614174000";

test("activates the bundled picker through extension transport on first and repeated use, and keeps toast clicks working inside an open modal dialog, after it closes and with the picker armed", async ({
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
          <dialog id="modal"><p>Fixture dialog</p></dialog>
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

    const cdp = await context.newCDPSession(page);
    await activatePicker(worker, fixtureUrl, CANCEL_SESSION_TOKEN);
    const overlay = page.locator('[data-provenance-lens-picker="overlay"]');
    const banner = page.locator('[data-provenance-lens-picker="banner"]');
    await expect(overlay).toHaveCount(1);
    await expect(banner).toHaveCount(1);
    // The banner lives in a closed shadow root, so read it through CDP.
    await expect
      .poll(() => shadowText(cdp, "data-picker-banner"))
      .toBe("Verify · Click an image · Esc to cancel");
    await expect
      .poll(() => page.evaluate(() => document.documentElement.style.cursor))
      .toBe("crosshair");
    await page.keyboard.press("Escape");
    await expect(overlay).toHaveCount(0);
    await expect(banner).toHaveCount(0);
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
    await expect(banner).toHaveCount(1);
    const image = page.locator("#target-image");
    const imageBox = await image.boundingBox();
    expect(imageBox).not.toBeNull();
    const imageX = (imageBox?.x ?? 0) + 160;
    const imageY = (imageBox?.y ?? 0) + 90;
    await page.mouse.move(imageX, imageY);
    await expect(overlay).toHaveAttribute(
      "aria-label",
      /Image · 320 × 180 px · Click to verify · Esc to cancel/u,
    );
    await page.mouse.click(imageX, imageY);
    await expect(overlay).toHaveCount(0);
    await expect(banner).toHaveCount(0);
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

    // A page modal dialog makes everything outside it inert, so the result
    // toast mounts inside the dialog, and the dialog never sees its clicks.
    await page.evaluate(() => {
      const scope = window as Window & { __pageEvents?: string[] };
      scope.__pageEvents = [];
      const dialog = document.querySelector<HTMLDialogElement>("#modal");
      if (!dialog) throw new Error("The fixture dialog was not found.");
      for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
        dialog.addEventListener(type, () =>
          scope.__pageEvents?.push(`dialog ${type}`),
        );
        document.addEventListener(type, () =>
          scope.__pageEvents?.push(`page ${type}`),
        );
      }
      dialog.showModal();
    });
    const toastMessage = {
      type: "show-toast",
      runtimeVersion: PICKER_RUNTIME_VERSION,
      sessionToken: SELECT_SESSION_TOKEN,
      tone: "no-signal",
      title: "No supported signal found",
      message: "No signal is not proof of human authorship.",
      resultId: null,
      actions: ["history"],
    };
    await sendToPage(worker, fixtureUrl, toastMessage);
    const toast = page.locator('[data-provenance-lens-toast="true"]');
    await expect(toast).toHaveCount(1);
    expect(
      await toast.evaluate((element) => element.parentElement?.id ?? null),
    ).toBe("modal");

    await clickShadowElement(page, cdp, "data-toast-action", "history");
    await expect
      .poll(() => observedMessages(worker, "toast-action"))
      .toEqual([
        {
          type: "toast-action",
          sessionToken: SELECT_SESSION_TOKEN,
          action: "history",
        },
      ]);
    await clickShadowElement(page, cdp, "data-toast-dismiss", "true");
    await expect(toast).toHaveCount(0);
    expect(
      await page.evaluate(() => ({
        open: document.querySelector<HTMLDialogElement>("#modal")?.open,
        events: (window as Window & { __pageEvents?: string[] }).__pageEvents,
      })),
    ).toEqual({ open: true, events: [] });

    // A page that closes and then removes its dialog takes the toast out of
    // the document, so the toast mounts again on the root element.
    await sendToPage(worker, fixtureUrl, toastMessage);
    await expect(toast).toHaveCount(1);
    expect(
      await toast.evaluate((element) => element.parentElement?.id ?? null),
    ).toBe("modal");
    await page.evaluate(() => {
      const dialog = document.querySelector<HTMLDialogElement>("#modal");
      dialog?.close();
      dialog?.remove();
    });
    await expect
      .poll(() =>
        toast.evaluate((element) => ({
          parent: element.parentElement?.localName,
          visible: element.checkVisibility(),
        })),
      )
      .toEqual({ parent: "html", visible: true });
    await clickShadowElement(page, cdp, "data-toast-action", "history");
    await expect
      .poll(async () => (await observedMessages(worker, "toast-action")).length)
      .toBe(2);

    // The toast's buttons work while a picker is armed.
    await activatePicker(worker, fixtureUrl, ARMED_SESSION_TOKEN);
    await expect(banner).toHaveCount(1);
    await clickShadowElement(page, cdp, "data-toast-action", "history");
    await expect
      .poll(async () => (await observedMessages(worker, "toast-action")).length)
      .toBe(3);
    await expect(banner).toHaveCount(1);
    expect(await observedMessages(worker, "picker-selected")).toHaveLength(1);

    // A page that enters fullscreen while the picker is armed gets the toast,
    // banner and overlay inside its fullscreen element, and back on leaving.
    const surfaceParents = (): Promise<string[]> =>
      page.evaluate(() =>
        Array.from(
          document.querySelectorAll(
            '[data-provenance-lens-picker], [data-provenance-lens-toast="true"]',
          ),
          (element) =>
            element.parentElement?.id || element.parentElement?.localName || "",
        ),
      );
    await page.evaluate(async () => {
      const player = document.createElement("div");
      player.id = "player";
      document.body.append(player);
      await player.requestFullscreen();
    });
    await expect.poll(surfaceParents).toEqual(["player", "player", "player"]);
    await page.evaluate(() => document.exitFullscreen());
    await expect.poll(surfaceParents).toEqual(["html", "html", "html"]);
    await page.keyboard.press("Escape");
    await expect(banner).toHaveCount(0);
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

async function sendToPage(
  worker: Worker,
  pageUrl: string,
  message: Record<string, unknown>,
): Promise<void> {
  await worker.evaluate(
    async ({ pageUrl, message }) => {
      const [tab] = await chrome.tabs.query({ url: pageUrl });
      if (!tab?.id) throw new Error("The picker fixture tab was not found.");
      await chrome.tabs.sendMessage(tab.id, message, { frameId: 0 });
    },
    { pageUrl, message },
  );
}

interface CdpNode {
  nodeId: number;
  nodeType: number;
  nodeValue: string;
  attributes?: string[];
  children?: CdpNode[];
  shadowRoots?: CdpNode[];
}

/** Finds an element by attribute, closed shadow roots included. */
async function findShadowNode(
  cdp: CDPSession,
  attribute: string,
  value?: string,
): Promise<CdpNode | null> {
  const { root } = (await cdp.send("DOM.getDocument", {
    depth: -1,
    pierce: true,
  })) as { root: CdpNode };
  const search = (node: CdpNode): CdpNode | null => {
    const attributes = node.attributes ?? [];
    for (let index = 0; index < attributes.length; index += 2) {
      if (
        attributes[index] === attribute &&
        (value === undefined || attributes[index + 1] === value)
      )
        return node;
    }
    for (const child of [
      ...(node.shadowRoots ?? []),
      ...(node.children ?? []),
    ]) {
      const found = search(child);
      if (found) return found;
    }
    return null;
  };
  return search(root);
}

async function shadowText(
  cdp: CDPSession,
  attribute: string,
): Promise<string | null> {
  const node = await findShadowNode(cdp, attribute);
  if (!node) return null;
  const text = (current: CdpNode): string =>
    current.nodeType === 3
      ? current.nodeValue
      : (current.children ?? []).map(text).join("");
  return text(node);
}

/** Clicks the centre of an element in a closed shadow root with the mouse. */
async function clickShadowElement(
  page: Page,
  cdp: CDPSession,
  attribute: string,
  value: string,
): Promise<void> {
  const node = await findShadowNode(cdp, attribute, value);
  if (!node) throw new Error(`No element has ${attribute}="${value}".`);
  const { model } = (await cdp.send("DOM.getBoxModel", {
    nodeId: node.nodeId,
  })) as { model: { content: number[] } };
  const [x1 = 0, y1 = 0, , , x3 = 0, y3 = 0] = model.content;
  await page.mouse.click((x1 + x3) / 2, (y1 + y3) / 2);
}

async function installMessageObserver(worker: Worker): Promise<void> {
  // A worker found right after launch can answer before its extension APIs
  // are bound; wait for them instead of failing on an undefined chrome.runtime.
  await expect
    .poll(() =>
      worker.evaluate(
        () => typeof globalThis.chrome?.runtime?.onMessage === "object",
      ),
    )
    .toBe(true);
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
  type: "picker-cancelled" | "picker-selected" | "toast-action",
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
