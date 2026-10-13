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

async function launchLens(): Promise<Lens> {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(request.url?.startsWith("/embed") ? EMBED_HTML : PAGE_HTML);
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
    background: { service_worker: string };
  };
  manifest.host_permissions.push("http://127.0.0.1/*");
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

test("ignores a click on a row while the page hides the palette", async () => {
  const lens = await launchLens();
  try {
    const page = await lens.context.newPage();
    await page.goto(`${lens.origin}/page.html`);
    const frame = await openPalette(lens, page);
    await frame.getByRole("option", { name: /^Verify/u }).click();
    await expect(frame.locator("#chip")).toHaveText("Verify");

    // The page makes the host transparent: the click still lands on the
    // row, but the row does not run.
    await page.evaluate(() =>
      document
        .querySelector<HTMLElement>("[data-provenance-lens-palette]")
        ?.style.setProperty("opacity", "0", "important"),
    );
    await expect(frame.locator("#palette")).toHaveAttribute(
      "data-visible",
      "false",
    );
    const pickRow = frame.getByRole("option", {
      name: /^Pick an image to verify/u,
    });
    await pickRow.click();
    await expect(frame.locator("#status-text")).toHaveText(
      "The page is covering Lens. Press Esc and open it again.",
    );
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    const starts = async () =>
      (await observed(lens)).filter(
        ({ message }) => message["type"] === "start-action",
      );
    expect(await starts()).toEqual([]);
    expect(await hostCount(page)).toBe(1);

    // Visible again, the same click runs the row.
    await page.evaluate(() =>
      document
        .querySelector<HTMLElement>("[data-provenance-lens-palette]")
        ?.style.setProperty("opacity", "1", "important"),
    );
    await takesClicks(page, frame);
    await pickRow.click();
    await expect.poll(() => hostCount(page)).toBe(0);
    await expect
      .poll(async () => (await starts()).map(({ message }) => message))
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
