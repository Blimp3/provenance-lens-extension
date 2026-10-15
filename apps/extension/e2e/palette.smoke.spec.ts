import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Frame,
  type Page,
  type Worker,
} from "@playwright/test";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const OPEN_KEY = "provenanceLens.paletteOpen";
const WORKFLOW_KEY = "provenanceLens.workflow";
const STRANGER_TOKEN = "923e4567-e89b-42d3-a456-426614174000";

const PAGE_HTML = `<!doctype html>
<html lang="en">
  <body style="margin: 0; min-height: 100vh;">
    <input id="field" aria-label="Page field">
    <button id="spot" type="button">Page button</button>
    <div id="stage" style="width: 640px; height: 360px; background: #ccc;"></div>
    <dialog id="modal" style="width: 300px; height: 120px;">
      <button id="modal-button">Modal button</button>
    </dialog>
    <script>
      window.__pageEvents = [];
      for (const type of ["keydown", "keyup", "pointerdown", "click"]) {
        document.addEventListener(type, (event) => {
          if (event.target && event.target.id === "field") return;
          window.__pageEvents.push(type);
        });
      }
    </script>
  </body>
</html>`;

// The owner's check page: a modal dialog that holds an image.
const DIALOG_HTML = `<!doctype html>
<html lang="en">
  <body style="margin: 0; min-height: 100vh;">
    <button id="open" type="button">Open dialog</button>
    <dialog id="modal" style="width: 420px; height: 300px;">
      <img id="image" src="/image.png" alt="Fixture" width="320" height="180">
    </dialog>
    <script>
      document.querySelector("#open").addEventListener("click", () =>
        document.querySelector("#modal").showModal(),
      );
    </script>
  </body>
</html>`;

// A talk page's player at the top-left corner: a custom element whose open
// shadow root holds a slotted video, so a hit test at (0, 0) meets the
// shadow root's host again inside it.
const TALK_HTML = `<!doctype html>
<html lang="en">
  <head><title>Talk fixture</title></head>
  <body style="margin: 0;">
    <main>
      <media-player style="display: block; width: 640px; height: 360px;">
        <video id="talk-video" slot="media" muted playsinline></video>
      </media-player>
    </main>
    <script>
      customElements.define(
        "media-player",
        class extends HTMLElement {
          constructor() {
            super();
            const shadow = this.attachShadow({ mode: "open" });
            shadow.innerHTML =
              "<style>:host { position: relative; background: #000; }" +
              " ::slotted(video) { display: block; width: 100%; height: 100%; }" +
              " .bar { position: absolute; inset: auto 0 0 0; height: 44px;" +
              " background: rgb(0 0 0 / 0.5); }</style>" +
              '<slot name="media"></slot>' +
              '<div class="bar"><button type="button">Play</button></div>';
          }
        },
      );
      const video = document.querySelector("#talk-video");
      video.src = URL.createObjectURL(new MediaSource());
    </script>
  </body>
</html>`;

const EMBED_HTML = `<!doctype html>
<html lang="en">
  <body>
    <script>
      window.__messages = [];
      window.addEventListener("message", (event) => {
        window.__messages.push(event.data);
      });
      const frame = document.createElement("iframe");
      frame.id = "embedded";
      frame.src = new URLSearchParams(location.search).get("src");
      frame.style.width = "800px";
      frame.style.height = "500px";
      document.body.append(frame);
    </script>
  </body>
</html>`;

// Captures the toolbar listener and every runtime message before the
// worker starts, so a test can click the toolbar icon and read what the
// palette frame sent. The test copy also has a 127.0.0.1 host permission,
// which stands in for the activeTab grant a real click gives.
const TEST_PATCH = `globalThis.__lensMessages = [];
globalThis.__lensToolbar = [];
const onClicked = chrome.action.onClicked;
const addListener = onClicked.addListener.bind(onClicked);
onClicked.addListener = (listener) => {
  globalThis.__lensToolbar.push(listener);
  return addListener(listener);
};
chrome.runtime.onMessage.addListener((message, sender) => {
  globalThis.__lensMessages.push({
    message,
    frameId: sender.frameId,
    tabId: sender.tab ? sender.tab.id : null,
  });
});
`;

type Lens = {
  context: BrowserContext;
  worker: Worker;
  extensionId: string;
  origin: string;
  requests: string[];
  close: () => Promise<void>;
};

type ObservedMessage = {
  message: Record<string, unknown>;
  frameId: number | undefined;
  tabId: number | null;
};

async function launchLens(
  options: { downloads?: boolean } = {},
): Promise<Lens> {
  const image = await readFile(
    resolve(process.cwd(), "tests/fixtures/image-fixture.png"),
  );
  const server = createServer((request, response) => {
    if (request.url === "/image.png") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(image);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      request.url?.startsWith("/embed")
        ? EMBED_HTML
        : request.url?.startsWith("/dialog")
          ? DIALOG_HTML
          : request.url?.startsWith("/talk")
            ? TALK_HTML
            : PAGE_HTML,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("The palette fixture server did not start.");
  const origin = `http://127.0.0.1:${address.port}`;

  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "provenance-lens-palette-"),
  );
  const extensionPath = resolve(temporaryRoot, "extension");
  await cp(resolve(process.cwd(), "dist"), extensionPath, { recursive: true });
  await writeFile(resolve(extensionPath, "lens-test-patch.js"), TEST_PATCH);
  await writeFile(
    resolve(extensionPath, "lens-test-worker.js"),
    'import "./lens-test-patch.js";\nimport "./background.js";\n',
  );
  const manifestPath = resolve(extensionPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    host_permissions: string[];
    permissions: string[];
    background: { service_worker: string };
  };
  manifest.host_permissions.push("http://127.0.0.1/*");
  // Stands in for the optional downloads grant.
  if (options.downloads) manifest.permissions.push("downloads");
  manifest.background.service_worker = "lens-test-worker.js";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const requests: string[] = [];
  const { context, worker } = await launchWithWorker(
    extensionPath,
    temporaryRoot,
    // Every web request is recorded; only the fixture server answers.
    (launched) =>
      launched.route(/^https?:\/\//u, async (route) => {
        const url = route.request().url();
        requests.push(url);
        if (url.startsWith(`${origin}/`)) await route.continue();
        else await route.abort();
      }),
  );
  await expect
    .poll(() =>
      worker.evaluate(
        () =>
          Array.isArray(
            (globalThis as { __lensToolbar?: unknown[] }).__lensToolbar,
          ) &&
          ((globalThis as { __lensToolbar?: unknown[] }).__lensToolbar
            ?.length ?? 0) > 0,
      ),
    )
    .toBe(true);
  return {
    context,
    worker,
    extensionId: new URL(worker.url()).hostname,
    origin,
    requests,
    close: async () => {
      await context.close();
      await closeServer(server);
      await rm(temporaryRoot, { recursive: true, force: true });
    },
  };
}

/**
 * Launches Chromium with the extension and returns its worker. With several
 * browsers starting at once, Chromium now and then never reports the worker
 * to Playwright; a second launch with a fresh profile does.
 */
async function launchWithWorker(
  extensionPath: string,
  temporaryRoot: string,
  prepare: (context: BrowserContext) => Promise<unknown>,
): Promise<{ context: BrowserContext; worker: Worker }> {
  for (let attempt = 1; ; attempt += 1) {
    const context = await chromium.launchPersistentContext(
      resolve(temporaryRoot, `profile-${attempt}`),
      {
        channel: "chromium",
        headless: true,
        args: [
          `--disable-extensions-except=${extensionPath}`,
          `--load-extension=${extensionPath}`,
        ],
      },
    );
    await prepare(context);
    const worker =
      context.serviceWorkers()[0] ??
      (await context
        .waitForEvent("serviceworker", { timeout: 10_000 })
        .catch(() => undefined));
    if (worker) return { context, worker };
    await context.close();
    if (attempt === 2)
      throw new Error("Chromium did not report the extension's worker.");
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

/** Clicks the toolbar icon for the tab that shows this page. */
async function clickToolbar(lens: Lens, page: Page): Promise<void> {
  await page.bringToFront();
  await lens.worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    if (!tab) throw new Error("The fixture tab was not found.");
    const listeners = (
      globalThis as unknown as {
        __lensToolbar: Array<(tab: chrome.tabs.Tab) => void>;
      }
    ).__lensToolbar;
    for (const listener of listeners) listener(tab);
  }, page.url());
}

function paletteFrame(page: Page): Frame | undefined {
  // A frame that is still attaching has an empty URL.
  return page
    .frames()
    .find((frame) => URL.parse(frame.url())?.pathname === "/palette.html");
}

/** Opens the palette from the toolbar and waits until it takes input. */
async function openPalette(lens: Lens, page: Page): Promise<Frame> {
  await clickToolbar(lens, page);
  await expect.poll(() => paletteFrame(page) !== undefined).toBe(true);
  const frame = paletteFrame(page) as Frame;
  await expect(frame.locator("#panel")).toBeVisible();
  await expect(frame.locator("#query")).toBeFocused();
  await takesClicks(page, frame);
  return frame;
}

/**
 * Waits until the palette reports its panel visible, and a little longer,
 * since a click runs a row only once the panel has been visible for 500 ms.
 */
async function takesClicks(page: Page, frame: Frame): Promise<void> {
  await expect(frame.locator("#palette")).toHaveAttribute(
    "data-visible",
    "true",
  );
  await page.waitForTimeout(600);
}

function hostCount(page: Page): Promise<number> {
  return page.locator("[data-provenance-lens-palette]").count();
}

function hostParentName(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      document.querySelector("[data-provenance-lens-palette]")?.parentElement
        ?.localName ?? null,
  );
}

/**
 * A key that removes the focused frame: the browser may never acknowledge
 * its keydown or keyup, so each gets a time limit.
 */
async function pressClosing(page: Page, ...keys: string[]): Promise<void> {
  for (const key of keys)
    await Promise.race([page.keyboard.down(key), page.waitForTimeout(1_000)]);
  await page.waitForTimeout(200);
  for (const key of [...keys].reverse())
    await Promise.race([page.keyboard.up(key), page.waitForTimeout(1_000)]);
}

function observed(lens: Lens): Promise<ObservedMessage[]> {
  return lens.worker.evaluate(
    () =>
      (globalThis as unknown as { __lensMessages: ObservedMessage[] })
        .__lensMessages,
  );
}

async function startActions(lens: Lens): Promise<Record<string, unknown>[]> {
  return (await observed(lens))
    .filter(({ message }) => message["type"] === "start-action")
    .map(({ message }) => message);
}

/**
 * Lays a page popover over the palette: it lets clicks through to the frame,
 * and IntersectionObserver v2 reports the panel covered.
 */
async function coverPalette(page: Page): Promise<void> {
  await page.evaluate(() => {
    let cover = document.querySelector<HTMLElement>("#cover");
    if (!cover) {
      cover = document.createElement("div");
      cover.id = "cover";
      cover.setAttribute("popover", "manual");
      cover.style.cssText =
        "inset: 0; width: 100vw; height: 100vh; margin: 0; border: 0; " +
        "padding: 0; background: rgb(255 255 255 / 0.9); pointer-events: none;";
      document.body.append(cover);
    }
    cover.showPopover();
  });
}

function uncoverPalette(page: Page): Promise<void> {
  return page.evaluate(() =>
    document.querySelector<HTMLElement>("#cover")?.hidePopover(),
  );
}

async function tabIdOf(lens: Lens, page: Page): Promise<number | undefined> {
  return lens.worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    return tab?.id;
  }, page.url());
}

function sessionValue(lens: Lens, key: string): Promise<unknown> {
  return lens.worker.evaluate(async (name) => {
    const values = await chrome.storage.session.get(name);
    return values[name] ?? null;
  }, key);
}

type CdpNode = {
  nodeType: number;
  nodeValue: string;
  attributes?: string[];
  children?: CdpNode[];
  shadowRoots?: CdpNode[];
};

/** The text of the page's toast, read through its closed shadow root. */
async function toastText(page: Page): Promise<string> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = (await cdp.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    })) as { root: CdpNode };
    const inside = (node: CdpNode): CdpNode[] => [
      ...(node.shadowRoots ?? []),
      ...(node.children ?? []),
    ];
    const find = (node: CdpNode): CdpNode | null => {
      if (node.attributes?.includes("data-provenance-lens-toast")) return node;
      for (const child of inside(node)) {
        const found = find(child);
        if (found) return found;
      }
      return null;
    };
    const text = (node: CdpNode): string =>
      node.nodeType === 3 ? node.nodeValue : inside(node).map(text).join(" ");
    const toast = find(root);
    return toast ? text(toast) : "";
  } finally {
    await cdp.detach();
  }
}

/** The worker's workflow state, which lives in local storage. */
function workflowState(lens: Lens): Promise<{ status?: string } | null> {
  return lens.worker.evaluate(async (name) => {
    const values = await chrome.storage.local.get(name);
    return (values[name] as { status?: string } | undefined) ?? null;
  }, WORKFLOW_KEY);
}

test("mounts the palette through the worker without starting an action or a request", async () => {
  const lens = await launchLens();
  try {
    const page = await lens.context.newPage();
    await page.goto(`${lens.origin}/page.html`);
    // Not a field: the page records every key that reaches it.
    await page.locator("#spot").focus();
    lens.requests.length = 0;

    const frame = await openPalette(lens, page);

    expect(await hostCount(page)).toBe(1);
    await expect(
      frame.getByRole("option", { name: /^Download/u }),
    ).toBeVisible();
    await expect(frame.getByRole("option", { name: /^Verify/u })).toBeVisible();
    // The single-use record is gone once the frame has read it.
    expect(await sessionValue(lens, OPEN_KEY)).toBeNull();
    await page.waitForTimeout(500);
    expect(lens.requests).toEqual([]);
    expect(await workflowState(lens)).toBeNull();
    expect(
      (await observed(lens)).filter(({ frameId }) => frameId !== 0),
    ).toEqual([]);

    // Keys stay inside the frame; Esc at the root closes and returns focus,
    // and the closing Esc's keyup does not reach the page either.
    await page.keyboard.type("clip");
    await expect(frame.getByRole("option", { name: /^Clip/u })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(frame.locator("#query")).toHaveValue("");
    await pressClosing(page, "Escape");
    await expect.poll(() => hostCount(page)).toBe(0);
    await expect(page.locator("#spot")).toBeFocused();
    expect(
      await page.evaluate(
        () => (window as Window & { __pageEvents?: string[] }).__pageEvents,
      ),
    ).toEqual([]);
    expect(lens.requests).toEqual([]);
  } finally {
    await lens.close();
  }
});

test("Alt+Digit1 sends start-action from the palette frame for its own tab", async () => {
  const lens = await launchLens();
  try {
    const page = await lens.context.newPage();
    await page.goto(`${lens.origin}/page.html`);
    const frame = await openPalette(lens, page);

    await page.keyboard.press("Alt+Digit2");
    const pickRow = frame.getByRole("option", {
      name: /^Pick an image to verify/u,
    });
    await expect(pickRow).toBeVisible();
    await expect(pickRow).toHaveAttribute("aria-keyshortcuts", "Alt+1");
    expect(await frame.locator("#query").inputValue()).toBe("");

    await pressClosing(page, "Alt", "Digit1");

    await expect.poll(() => hostCount(page)).toBe(0);
    const tabId = await tabIdOf(lens, page);
    await expect
      .poll(async () =>
        (await observed(lens))
          .filter(({ message }) => message["type"] === "start-action")
          .map(({ message, frameId, tabId: sender }) => ({
            message,
            fromPageFrame: frameId !== 0,
            sender,
          })),
      )
      .toEqual([
        {
          message: {
            type: "start-action",
            actionId: "verify-openai-provenance",
            trigger: "popup",
          },
          fromPageFrame: true,
          sender: tabId,
        },
      ]);
    // The worker took it: the run started (or asked for its disclosure).
    await expect
      .poll(async () => {
        const workflow = await workflowState(lens);
        const disclosure = lens.context
          .pages()
          .some((open) => open.url().includes("/disclosure.html"));
        return disclosure || (workflow?.status ?? "idle") !== "idle";
      })
      .toBe(true);
  } finally {
    await lens.close();
  }
});

test("a palette without its token stays blank, and an embedding page gets nothing", async () => {
  const lens = await launchLens();
  try {
    // A real palette consumes its token; a page that learns it later finds
    // nothing.
    const page = await lens.context.newPage();
    await page.goto(`${lens.origin}/page.html`);
    const frame = await openPalette(lens, page);
    const usedToken = new URL(frame.url()).hash.slice("#t=".length);
    expect(usedToken).toMatch(/^[0-9a-f-]{36}$/u);
    await pressClosing(page, "Escape");
    await expect.poll(() => hostCount(page)).toBe(0);

    const base = `chrome-extension://${lens.extensionId}/palette.html`;
    for (const source of [
      base,
      `${base}#t=${STRANGER_TOKEN}`,
      `${base}?host=popup#t=${STRANGER_TOKEN}`,
      `${base}#t=${usedToken}`,
    ]) {
      const embedding = await lens.context.newPage();
      await embedding.goto(
        `${lens.origin}/embed.html?src=${encodeURIComponent(source)}`,
      );
      await expect
        .poll(() => paletteFrame(embedding)?.url() ?? null)
        .toBe(source);
      const embedded = paletteFrame(embedding) as Frame;
      await embedded.waitForLoadState("load");
      // Give the frame time to read storage and render, if it ever would.
      await embedding.waitForTimeout(1_000);
      await expect(embedded.locator("#palette")).toHaveAttribute("hidden", "");
      await expect(embedded.locator("#panel")).toBeHidden();
      expect(await embedded.locator("#list").innerHTML()).toBe("");
      expect(
        await embedding.evaluate(
          () => (window as Window & { __messages?: unknown[] }).__messages,
        ),
      ).toEqual([]);

      // Even a message it sends itself does not start anything: the worker
      // never mounted a palette into this tab.
      const embeddingTab = await tabIdOf(lens, embedding);
      await embedded.evaluate(() =>
        chrome.runtime.sendMessage({
          type: "start-action",
          actionId: "verify-openai-provenance",
          trigger: "popup",
        }),
      );
      await expect
        .poll(async () =>
          (await observed(lens)).some(
            ({ tabId, message }) =>
              tabId === embeddingTab && message["type"] === "start-action",
          ),
        )
        .toBe(true);
      await embedding.waitForTimeout(500);
      expect(await workflowState(lens)).toBeNull();
      expect(
        lens.context
          .pages()
          .some((open) => open.url().includes("/disclosure.html")),
      ).toBe(false);
      await embedding.close();
    }

    // Opened as a tab or as the popup page, with no record from the worker,
    // the palette stays blank too.
    for (const source of [base, `${base}?host=popup`]) {
      const opened = await lens.context.newPage();
      await opened.goto(source);
      await opened.waitForTimeout(1_000);
      await expect(opened.locator("#palette")).toHaveAttribute("hidden", "");
      expect(await opened.locator("#list").innerHTML()).toBe("");
      await opened.close();
    }
    expect(
      lens.requests.filter((url) => !url.startsWith(`${lens.origin}/`)),
    ).toEqual([]);
  } finally {
    await lens.close();
  }
});

test("two palettes in two windows stay open", async () => {
  const lens = await launchLens();
  try {
    const first = await lens.context.newPage();
    await first.goto(`${lens.origin}/page.html?first`);
    const firstFrame = await openPalette(lens, first);

    const secondPromise = lens.context.waitForEvent("page");
    await lens.worker.evaluate(async (url) => {
      await chrome.windows.create({ url, focused: true });
    }, `${lens.origin}/page.html?second`);
    const second = await secondPromise;
    await second.waitForLoadState("load");
    const secondFrame = await openPalette(lens, second);

    await second.waitForTimeout(500);
    expect(await hostCount(first)).toBe(1);
    expect(await hostCount(second)).toBe(1);
    await secondFrame.locator("#query").fill("recent");
    await expect(
      secondFrame.getByRole("option", { name: /^Recent/u }),
    ).toBeVisible();

    // Closing one palette leaves the other one's port and frame alone.
    await pressClosing(second, "Escape");
    await pressClosing(second, "Escape");
    await expect.poll(() => hostCount(second)).toBe(0);
    await first.bringToFront();
    await first.waitForTimeout(300);
    expect(await hostCount(first)).toBe(1);
    await firstFrame.locator("#query").fill("clip");
    await expect(
      firstFrame.getByRole("option", { name: /^Clip/u }),
    ).toBeVisible();
  } finally {
    await lens.close();
  }
});

test("a click lands in the palette above a modal dialog and a fullscreen element", async () => {
  const lens = await launchLens();
  try {
    const page = await lens.context.newPage();
    await page.goto(`${lens.origin}/page.html`);

    await page.evaluate(() =>
      document.querySelector<HTMLDialogElement>("#modal")?.showModal(),
    );
    let frame = await openPalette(lens, page);
    expect(
      await page.evaluate(
        () =>
          document.querySelector("[data-provenance-lens-palette]")
            ?.parentElement?.id,
      ),
    ).toBe("modal");
    await frame.getByRole("option", { name: /^Recent/u }).click();
    await expect(frame.locator("#chip")).toHaveText("Recent");
    expect(
      await page.evaluate(
        () => (window as Window & { __pageEvents?: string[] }).__pageEvents,
      ),
    ).toEqual([]);

    // The page closes its dialog: the palette mounts again on top and still
    // takes clicks.
    await page.evaluate(() =>
      document.querySelector<HTMLDialogElement>("#modal")?.close(),
    );
    await expect.poll(() => hostParentName(page)).toBe("html");
    await frame.locator("#chip").click();
    await expect(frame.locator("#chip")).toBeHidden();
    await pressClosing(page, "Escape");
    await expect.poll(() => hostCount(page)).toBe(0);
    expect(
      await page.evaluate(
        () => (window as Window & { __pageEvents?: string[] }).__pageEvents,
      ),
    ).toEqual([]);

    await page.evaluate(() =>
      document.querySelector("#stage")?.requestFullscreen(),
    );
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement?.id ?? null))
      .toBe("stage");
    frame = await openPalette(lens, page);
    expect(
      await page.evaluate(
        () =>
          document.querySelector("[data-provenance-lens-palette]")
            ?.parentElement?.id,
      ),
    ).toBe("stage");
    await frame.getByRole("option", { name: /^Clip/u }).click();
    await expect(frame.locator("#chip")).toHaveText("Clip");
    expect(
      await page.evaluate(
        () => (window as Window & { __pageEvents?: string[] }).__pageEvents,
      ),
    ).toEqual([]);

    // Leaving fullscreen mounts it again on top too.
    await page.evaluate(() => document.exitFullscreen());
    await expect.poll(() => hostParentName(page)).toBe("html");
    await expect(frame.locator("#panel")).toBeVisible();
    await frame.locator("#chip").click();
    await expect(frame.locator("#chip")).toBeHidden();
    expect(
      await page.evaluate(
        () => (window as Window & { __pageEvents?: string[] }).__pageEvents,
      ),
    ).toEqual([]);

    // The root element going fullscreen keeps the host's parent, and the
    // host is shown again above the fullscreen layer.
    await page.evaluate(() => document.documentElement.requestFullscreen());
    await expect
      .poll(() =>
        page.evaluate(() => document.fullscreenElement?.localName ?? null),
      )
      .toBe("html");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document
              .elementFromPoint(innerWidth / 2, innerHeight / 2)
              ?.hasAttribute("data-provenance-lens-palette") ?? false,
        ),
      )
      .toBe(true);
    await takesClicks(page, frame);
    await frame.getByRole("option", { name: /^Recent/u }).click();
    await expect(frame.locator("#chip")).toHaveText("Recent");
    await frame.locator("#chip").click();
    await page.evaluate(() => document.exitFullscreen());
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement))
      .toBeNull();

    // Entering fullscreen with the palette open mounts it inside the
    // fullscreen element, on top, still focused and taking clicks.
    await frame.locator("#query").focus();
    await expect(frame.locator("#query")).toBeFocused();
    await page.evaluate(() =>
      document.querySelector("#stage")?.requestFullscreen(),
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.querySelector("[data-provenance-lens-palette]")
              ?.parentElement?.id,
        ),
      )
      .toBe("stage");
    await expect(frame.locator("#query")).toBeFocused();
    await takesClicks(page, frame);
    await frame.getByRole("option", { name: /^Recent/u }).click();
    await expect(frame.locator("#chip")).toHaveText("Recent");
    await page.evaluate(() => document.exitFullscreen());
    await expect.poll(() => hostParentName(page)).toBe("html");
    await frame.locator("#chip").click();
    await expect(frame.locator("#chip")).toBeHidden();
    await pressClosing(page, "Escape");
    await expect.poll(() => hostCount(page)).toBe(0);

    // A page that closes its dialog and removes it takes the frame with it:
    // the palette closes, and the next open shows a working palette.
    await page.evaluate(() => {
      (window as Window & { __pageEvents?: string[] }).__pageEvents = [];
      document.querySelector<HTMLDialogElement>("#modal")?.showModal();
    });
    frame = await openPalette(lens, page);
    expect(
      await page.evaluate(
        () =>
          document.querySelector("[data-provenance-lens-palette]")
            ?.parentElement?.id,
      ),
    ).toBe("modal");
    await page.evaluate(() => {
      const dialog = document.querySelector<HTMLDialogElement>("#modal");
      dialog?.close();
      dialog?.remove();
    });
    await expect.poll(() => hostCount(page)).toBe(0);
    frame = await openPalette(lens, page);
    expect(await hostParentName(page)).toBe("html");
    await frame.getByRole("option", { name: /^Recent/u }).click();
    await expect(frame.locator("#chip")).toHaveText("Recent");
    expect(
      await page.evaluate(
        () => (window as Window & { __pageEvents?: string[] }).__pageEvents,
      ),
    ).toEqual([]);
  } finally {
    await lens.close();
  }
});

test("ignores a click, a key and an action while a page element covers the palette", async () => {
  const lens = await launchLens();
  try {
    const page = await lens.context.newPage();
    await page.goto(`${lens.origin}/page.html`);
    const frame = await openPalette(lens, page);
    await frame.locator("#query").fill("v");
    const pickRow = frame.getByRole("option").first();
    await expect(pickRow).toHaveAccessibleName(/^Pick an image to verify/u);

    // The click still lands on the row, but the row does not run.
    await coverPalette(page);
    await expect(frame.locator("#palette")).toHaveAttribute(
      "data-visible",
      "false",
    );
    await pickRow.click();
    await expect(frame.locator("#status-text")).toHaveText(
      "The page is covering Lens. Press Esc and open it again.",
    );
    await page.keyboard.press("Enter");
    // Nor does Run in the ⌘K panel.
    await page.keyboard.press("Control+KeyK");
    await expect(frame.locator("#actions")).toBeVisible();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    expect(await startActions(lens)).toEqual([]);
    expect(await hostCount(page)).toBe(1);

    // Uncovered, the message goes and the same click runs the row.
    await uncoverPalette(page);
    await takesClicks(page, frame);
    await expect(frame.locator("#status-text")).not.toHaveText(
      "The page is covering Lens. Press Esc and open it again.",
    );
    await page.keyboard.press("Escape");
    await expect(frame.locator("#actions")).toBeHidden();
    await pickRow.click();
    await expect.poll(() => hostCount(page)).toBe(0);
    await expect
      .poll(() => startActions(lens))
      .toEqual([
        {
          type: "start-action",
          actionId: "verify-openai-provenance",
          trigger: "popup",
        },
      ]);
  } finally {
    await lens.close();
  }
});

test("closes the palette when the page masks, hides or moves its host", async () => {
  const lens = await launchLens();
  try {
    const page = await lens.context.newPage();
    await page.goto(`${lens.origin}/page.html`);

    /** Opens the Verify view and returns the centre of its pick row. */
    const openAtPickRow = async (): Promise<{
      x: number;
      y: number;
      height: number;
    }> => {
      const frame = await openPalette(lens, page);
      await frame.getByRole("option", { name: /^Verify/u }).click();
      const pickRow = frame.getByRole("option", {
        name: /^Pick an image to verify/u,
      });
      await expect(pickRow).toBeVisible();
      await takesClicks(page, frame);
      const box = await pickRow.boundingBox();
      if (!box) throw new Error("The pick row has no box.");
      return {
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
        height: box.height,
      };
    };
    /** The user clicks where the row was and presses Enter. */
    const userTries = async (spot: { x: number; y: number }): Promise<void> => {
      await page.mouse.click(spot.x, spot.y);
      await page.keyboard.press("Enter");
    };

    // A mask the frame's IntersectionObserver v2 does not see.
    for (const property of [
      "mask-image",
      "-webkit-mask-image",
      "mask",
      "mask-border-source",
      "-webkit-mask-box-image-source",
    ]) {
      const spot = await openAtPickRow();
      const applied = await page.evaluate((name) => {
        const host = document.querySelector<HTMLElement>(
          "[data-provenance-lens-palette]",
        );
        host?.style.setProperty(
          name,
          "linear-gradient(transparent, transparent)",
          "important",
        );
        return host?.style.getPropertyValue(name) !== "";
      }, property);
      // Chromium without mask-border ignores that property: nothing changes.
      if (!applied) {
        expect(property).toBe("mask-border-source");
        await page.keyboard.press("Escape");
        await pressClosing(page, "Escape");
        await expect.poll(() => hostCount(page)).toBe(0);
        continue;
      }
      await expect.poll(() => hostCount(page)).toBe(0);
      await userTries(spot);
    }

    // Hidden, the host leaves the top layer, and a masked parent would hide
    // it from the user but not from the frame.
    let spot = await openAtPickRow();
    await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>(
        "[data-provenance-lens-palette]",
      );
      const masked = document.createElement("div");
      masked.style.cssText =
        "position: fixed; inset: 0; " +
        "mask-image: linear-gradient(transparent, transparent);";
      document.body.append(masked);
      if (!host) return;
      host.hidePopover();
      masked.moveBefore(host, null);
    });
    await expect.poll(() => hostCount(page)).toBe(0);
    await userTries(spot);

    // A 2D translation moves another row under the user's click.
    spot = await openAtPickRow();
    await page.evaluate((shift) => {
      document
        .querySelector<HTMLElement>("[data-provenance-lens-palette]")
        ?.style.setProperty("transform", `translateY(${shift}px)`, "important");
    }, spot.height);
    await page.waitForTimeout(100);
    await userTries(spot);
    await expect.poll(() => hostCount(page)).toBe(0);

    await page.waitForTimeout(500);
    expect(await startActions(lens)).toEqual([]);
    expect(paletteFrame(page)).toBeUndefined();
  } finally {
    await lens.close();
  }
});

test("a click runs a row only once the panel has been visible for 500 ms", async () => {
  const lens = await launchLens();
  try {
    const page = await lens.context.newPage();
    await page.goto(`${lens.origin}/page.html`);
    await clickToolbar(lens, page);
    await expect.poll(() => paletteFrame(page) !== undefined).toBe(true);
    const frame = paletteFrame(page) as Frame;
    const verifyRow = frame.getByRole("option", { name: /^Verify/u });
    await expect(frame.locator("#palette")).toHaveAttribute(
      "data-visible",
      "true",
    );
    const visibleAt = Date.now();
    const box = await verifyRow.boundingBox();
    if (!box) throw new Error("The Verify row has no box.");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    expect(Date.now() - visibleAt).toBeLessThan(500);
    await expect(frame.locator("#status-text")).toHaveText(
      "The page is covering Lens. Press Esc and open it again.",
    );
    await expect(frame.locator("#chip")).toBeHidden();

    // Later, the same click runs the row, and the message goes.
    await page.waitForTimeout(600);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(frame.locator("#chip")).toHaveText("Verify");
    await expect(frame.locator("#status-text")).not.toHaveText(
      "The page is covering Lens. Press Esc and open it again.",
    );
  } finally {
    await lens.close();
  }
});

test("an alias and Enter typed as the palette opens run the row", async () => {
  const lens = await launchLens();
  try {
    const page = await lens.context.newPage();
    await page.goto(`${lens.origin}/page.html`);
    await clickToolbar(lens, page);
    await expect.poll(() => paletteFrame(page) !== undefined).toBe(true);
    const frame = paletteFrame(page) as Frame;
    // As soon as the input takes keys, before the panel has been visible
    // for 250 ms.
    await expect(frame.locator("#query")).toBeFocused();
    await expect
      .poll(() => frame.evaluate(() => document.hasFocus()))
      .toBe(true);
    await page.keyboard.type("v");
    await page.keyboard.press("Enter");

    await expect.poll(() => hostCount(page)).toBe(0);
    await expect
      .poll(() => startActions(lens))
      .toEqual([
        {
          type: "start-action",
          actionId: "verify-openai-provenance",
          trigger: "popup",
        },
      ]);
  } finally {
    await lens.close();
  }
});

test("a page cover lifted 15 ms in every 100 ms lets no key through", async () => {
  const lens = await launchLens();
  try {
    const page = await lens.context.newPage();
    await page.goto(`${lens.origin}/page.html`);
    const frame = await openPalette(lens, page);
    await frame.locator("#query").fill("v");
    await expect(frame.getByRole("option").first()).toHaveAccessibleName(
      /^Pick an image to verify/u,
    );

    await coverPalette(page);
    await page.evaluate(() => {
      const cover = document.querySelector<HTMLElement>("#cover");
      (window as Window & { __flicker?: number }).__flicker =
        window.setInterval(() => {
          cover?.hidePopover();
          setTimeout(() => cover?.showPopover(), 15);
        }, 100);
    });
    // IntersectionObserver v2 reports a new cover a frame or so late.
    await expect(frame.locator("#palette")).toHaveAttribute(
      "data-visible",
      "false",
    );
    for (let press = 0; press < 10; press += 1) {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(70);
    }
    await page.waitForTimeout(500);
    expect(await startActions(lens)).toEqual([]);
    expect(await hostCount(page)).toBe(1);

    // The keys did reach the frame: with the cover gone, Enter runs. The
    // last lift's show is still pending for up to 15 ms.
    await page.evaluate(async () => {
      clearInterval((window as Window & { __flicker?: number }).__flicker);
      await new Promise((resolve) => setTimeout(resolve, 50));
      document.querySelector<HTMLElement>("#cover")?.hidePopover();
    });
    await takesClicks(page, frame);
    await page.keyboard.press("Enter");
    await expect.poll(() => hostCount(page)).toBe(0);
    await expect
      .poll(() => startActions(lens))
      .toEqual([
        {
          type: "start-action",
          actionId: "verify-openai-provenance",
          trigger: "popup",
        },
      ]);
  } finally {
    await lens.close();
  }
});

test("the SynthID pick and its toast stay above a modal dialog", async () => {
  const lens = await launchLens({ downloads: true });
  try {
    await lens.worker.evaluate(() =>
      chrome.storage.local.set({ "provenanceLens.synthidDisclosure": 1 }),
    );
    const page = await lens.context.newPage();
    await page.goto(`${lens.origin}/dialog.html`);
    await page.click("#open");
    const frame = await openPalette(lens, page);
    expect(await hostParentName(page)).toBe("dialog");
    await page.keyboard.type("g");
    await expect(frame.getByRole("option").first()).toHaveAccessibleName(
      /^Check with Google SynthID/u,
    );
    await page.keyboard.press("Enter");
    await expect.poll(() => hostCount(page)).toBe(0);

    /** Whether a hit test at the toast's centre finds the toast. */
    const toastOnTop = (): Promise<boolean> =>
      page.evaluate(() => {
        const toast = document.querySelector<HTMLElement>(
          "[data-provenance-lens-toast]",
        );
        if (!toast?.matches(":popover-open")) return false;
        const box = toast.getBoundingClientRect();
        return (
          document.elementFromPoint(
            box.x + box.width / 2,
            box.y + box.height / 2,
          ) === toast
        );
      });
    // The banner and the label take no pointer events, so no hit test finds
    // them: each is a popover shown in the dialog after it opened, above it.
    for (const surface of ["banner", "overlay"]) {
      const root = page.locator(`[data-provenance-lens-picker="${surface}"]`);
      await expect(root).toHaveCount(1);
      expect(
        await root.evaluate((element) => ({
          parent: element.parentElement?.localName,
          open: element.matches(":popover-open"),
        })),
      ).toEqual({ parent: "dialog", open: true });
    }

    const image = await page.locator("#image").boundingBox();
    if (!image) throw new Error("The image has no box.");
    await page.mouse.move(
      image.x + image.width / 2,
      image.y + image.height / 2,
    );
    await page.mouse.click(
      image.x + image.width / 2,
      image.y + image.height / 2,
    );
    await page.bringToFront();
    const toast = page.locator("[data-provenance-lens-toast]");
    await expect(toast).toHaveCount(1, { timeout: 15_000 });
    await expect.poll(toastOnTop).toBe(true);
    await expect
      .poll(() => toast.evaluate((element) => element.parentElement?.localName))
      .toBe("dialog");
    expect(
      await page
        .locator("dialog")
        .evaluate((d) => (d as HTMLDialogElement).open),
    ).toBe(true);
  } finally {
    await lens.close();
  }
});

test("the first SynthID pick resumes above a modal dialog after the acknowledgement", async () => {
  const lens = await launchLens({ downloads: true });
  try {
    const page = await lens.context.newPage();
    await page.goto(`${lens.origin}/dialog.html`);
    await page.click("#open");
    const frame = await openPalette(lens, page);
    await page.keyboard.type("g");
    await expect(frame.getByRole("option").first()).toHaveAccessibleName(
      /^Check with Google SynthID/u,
    );
    const opened = lens.context.waitForEvent("page");
    await page.keyboard.press("Enter");
    await expect.poll(() => hostCount(page)).toBe(0);

    // The one-time acknowledgement opens in its own tab, then closes.
    const disclosure = await opened;
    await disclosure.waitForLoadState("load");
    expect(new URL(disclosure.url()).pathname).toBe("/disclosure.html");
    await expect(disclosure.locator("#acknowledge")).toBeEnabled();
    const closed = disclosure.waitForEvent("close");
    await disclosure.locator("#acknowledge").click();
    await closed;

    await page.bringToFront();
    for (const surface of ["banner", "overlay"]) {
      const root = page.locator(`[data-provenance-lens-picker="${surface}"]`);
      await expect(root).toHaveCount(1);
      await expect
        .poll(() =>
          root.evaluate((element) => ({
            parent: element.parentElement?.localName,
            open: element.matches(":popover-open"),
          })),
        )
        .toEqual({ parent: "dialog", open: true });
    }

    const image = await page.locator("#image").boundingBox();
    if (!image) throw new Error("The image has no box.");
    await page.mouse.move(
      image.x + image.width / 2,
      image.y + image.height / 2,
    );
    await page.mouse.click(
      image.x + image.width / 2,
      image.y + image.height / 2,
    );
    const toast = page.locator("[data-provenance-lens-toast]");
    await expect(toast).toHaveCount(1, { timeout: 15_000 });
    await expect.poll(() => toastText(page)).toContain("Exact image saved");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const root = document.querySelector<HTMLElement>(
            "[data-provenance-lens-toast]",
          );
          if (!root?.matches(":popover-open")) return null;
          const box = root.getBoundingClientRect();
          return {
            parent: root.parentElement?.localName,
            onTop:
              document.elementFromPoint(
                box.x + box.width / 2,
                box.y + box.height / 2,
              ) === root,
          };
        }),
      )
      .toEqual({ parent: "dialog", onTop: true });
    expect(
      await page
        .locator("dialog")
        .evaluate((d) => (d as HTMLDialogElement).open),
    ).toBe(true);
  } finally {
    await lens.close();
  }
});

test("closes the palette when the page cancels the host's show, and no key reaches the worker", async () => {
  const lens = await launchLens();
  try {
    const page = await lens.context.newPage();
    await page.goto(`${lens.origin}/page.html`);
    // The page cancels the host's way into the top layer, where it could
    // then move and mask the host.
    const cancelShows = (): Promise<void> =>
      page.evaluate(() => {
        const state = window as Window & { __cancelled?: number };
        state.__cancelled = 0;
        document.addEventListener(
          "beforetoggle",
          (event) => {
            const target = event.target as HTMLElement | null;
            if (
              event.newState === "open" &&
              target?.dataset["provenanceLensPalette"]
            ) {
              event.preventDefault();
              state.__cancelled = (state.__cancelled ?? 0) + 1;
            }
          },
          true,
        );
      });
    const cancelled = (): Promise<number> =>
      page.evaluate(
        () => (window as Window & { __cancelled?: number }).__cancelled ?? 0,
      );

    // The show that stacks the open palette on top again, after the page
    // closes the dialog the palette sits in.
    await page.evaluate(() =>
      document.querySelector<HTMLDialogElement>("#modal")?.showModal(),
    );
    await openPalette(lens, page);
    expect(await hostParentName(page)).toBe("dialog");
    await cancelShows();
    await page.evaluate(() =>
      document.querySelector<HTMLDialogElement>("#modal")?.close(),
    );
    await expect.poll(cancelled).toBe(1);
    await expect.poll(() => hostCount(page)).toBe(0);

    // The first show.
    await clickToolbar(lens, page);
    await expect.poll(cancelled).toBe(2);
    await expect.poll(() => hostCount(page)).toBe(0);
    await page.keyboard.type("v");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    expect(await startActions(lens)).toEqual([]);
  } finally {
    await lens.close();
  }
});

test("a page that stops the host's closing beforetoggle and hides it gets no run", async () => {
  const lens = await launchLens();
  try {
    const page = await lens.context.newPage();
    await page.goto(`${lens.origin}/page.html`);
    const frame = await openPalette(lens, page);
    // A capture listener on window hears the closing beforetoggle before the
    // host does and stops it; the page then hides the host and moves it into
    // a parent that masks it.
    await page.evaluate(() => {
      window.addEventListener(
        "beforetoggle",
        (event) => {
          const target = event.target as HTMLElement | null;
          if (target?.dataset["provenanceLensPalette"])
            event.stopImmediatePropagation();
        },
        true,
      );
      const host = document.querySelector<HTMLElement>(
        "[data-provenance-lens-palette]",
      );
      const masked = document.createElement("div");
      masked.style.cssText =
        "position: fixed; inset: 0; " +
        "mask-image: linear-gradient(transparent, transparent);";
      document.body.append(masked);
      if (!host) return;
      host.hidePopover();
      masked.moveBefore(host, null);
    });
    // The keys go to the frame's own input once a key could run there, which
    // a closed palette no longer has.
    await page.waitForTimeout(700);
    const query = frame.locator("#query");
    await query
      .press("v", { timeout: 2_000 })
      .then(() => query.press("Enter", { timeout: 2_000 }))
      .catch(() => undefined);
    await page.waitForTimeout(500);
    expect(await startActions(lens)).toEqual([]);
    expect(await hostCount(page)).toBe(0);

    // A plain open and run on the same page still runs.
    await openPalette(lens, page);
    await page.keyboard.type("v");
    await page.keyboard.press("Enter");
    await expect.poll(() => hostCount(page)).toBe(0);
    await expect
      .poll(() => startActions(lens))
      .toEqual([
        {
          type: "start-action",
          actionId: "verify-openai-provenance",
          trigger: "popup",
        },
      ]);
  } finally {
    await lens.close();
  }
});

test("the palette mounts on a page whose player's open shadow root is at the top-left corner", async () => {
  const lens = await launchLens();
  try {
    const page = await lens.context.newPage();
    await page.goto(`${lens.origin}/talk`);
    expect(
      await page.evaluate(
        () => document.elementsFromPoint(0, 0)[1]?.localName ?? null,
      ),
    ).toBe("media-player");
    // In the page, not the popup the worker opens when the host fails.
    const frame = await openPalette(lens, page);
    expect(await hostParentName(page)).toBe("html");

    // Leaving fullscreen restacks the palette by the same hit test, and it
    // keeps the keys.
    await page.evaluate(() =>
      document.querySelector("main")?.requestFullscreen(),
    );
    await expect.poll(() => hostParentName(page)).toBe("main");
    await page.evaluate(() => document.exitFullscreen());
    await expect.poll(() => hostParentName(page)).toBe("html");
    await takesClicks(page, frame);
    await page.keyboard.type("v");
    await page.keyboard.press("Enter");
    await expect.poll(() => hostCount(page)).toBe(0);
    await expect
      .poll(() => startActions(lens))
      .toEqual([
        {
          type: "start-action",
          actionId: "verify-openai-provenance",
          trigger: "popup",
        },
      ]);
  } finally {
    await lens.close();
  }
});

test("a zoom on the page restarts the 500 ms before a click runs a row", async () => {
  const lens = await launchLens();
  try {
    const page = await lens.context.newPage();
    await page.goto(`${lens.origin}/page.html`);
    const frame = await openPalette(lens, page);
    const verifyRow = frame.getByRole("option", { name: /^Verify/u });
    const resting = await verifyRow.boundingBox();
    if (!resting) throw new Error("The Verify row has no box.");
    await page.mouse.move(
      resting.x + resting.width / 2,
      resting.y + resting.height / 2,
    );

    // The zoom moves the rows under the resting pointer; a click within
    // 500 ms runs nothing.
    const width = await frame.evaluate(() => innerWidth);
    const zoomedAt = Date.now();
    await page.evaluate(() => {
      document.documentElement.style.zoom = "0.8";
    });
    await expect
      .poll(() => frame.evaluate(() => innerWidth), { intervals: [10] })
      .not.toBe(width);
    const box = await verifyRow.boundingBox();
    if (!box) throw new Error("The Verify row has no box.");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    expect(Date.now() - zoomedAt).toBeLessThan(500);
    await expect(frame.locator("#status-text")).toHaveText(
      "The page is covering Lens. Press Esc and open it again.",
    );
    await expect(frame.locator("#chip")).toBeHidden();
    expect(await startActions(lens)).toEqual([]);

    // Once the panel has stayed put for 500 ms, the same click runs the row
    // under it. Playwright's boxes leave the zoom out, so which row that is
    // is not checked.
    await page.waitForTimeout(600);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(frame.locator("#chip")).toBeVisible();
    await expect(frame.locator("#status-text")).not.toHaveText(
      "The page is covering Lens. Press Esc and open it again.",
    );
  } finally {
    await lens.close();
  }
});

test("Esc closes the palette in fullscreen and the page stays fullscreen", async () => {
  const lens = await launchLens();
  try {
    const page = await lens.context.newPage();
    await page.goto(`${lens.origin}/page.html`);
    await page.evaluate(() =>
      document.querySelector("#stage")?.requestFullscreen(),
    );
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement?.id ?? null))
      .toBe("stage");
    const frame = await openPalette(lens, page);
    await frame.getByRole("option", { name: /^Recent/u }).click();
    await expect(frame.locator("#chip")).toHaveText("Recent");

    // Esc steps back first, then closes; headless Chromium does not run the
    // browser's own Esc for fullscreen, which Keyboard Lock holds back.
    await page.keyboard.press("Escape");
    await expect(frame.locator("#chip")).toBeHidden();
    await pressClosing(page, "Escape");
    await expect.poll(() => hostCount(page)).toBe(0);
    expect(
      await page.evaluate(() => document.fullscreenElement?.id ?? null),
    ).toBe("stage");
  } finally {
    await lens.close();
  }
});

test("the Now row names the pick that runs", async () => {
  const lens = await launchLens();
  try {
    const page = await lens.context.newPage();
    await page.goto(`${lens.origin}/page.html`);
    for (const [message, title] of [
      ["Choose an image to download.", "Picking an image…"],
      [
        "Click an image or a video to send it to Telegram.",
        "Picking an image or a video…",
      ],
    ] as const) {
      await lens.worker.evaluate(
        ({ key, text }) =>
          chrome.storage.local.set({
            [key]: {
              status: "picking",
              actionId: "download-original-media",
              message: text,
              updatedAt: new Date().toISOString(),
            },
          }),
        { key: WORKFLOW_KEY, text: message },
      );
      const frame = await openPalette(lens, page);
      await expect(frame.getByRole("option").first()).toHaveAccessibleName(
        new RegExp(`^${title}`, "u"),
      );
      await pressClosing(page, "Escape");
      await expect.poll(() => hostCount(page)).toBe(0);
    }
  } finally {
    await lens.close();
  }
});
