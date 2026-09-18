import { chromium, expect, test } from "@playwright/test";
import {
  DEFAULT_BACKEND_URL,
  PICKER_RUNTIME_VERSION,
} from "@provenance-lens/shared";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";

test("loads the unpacked extension popup", async () => {
  const extensionPath = resolve(process.cwd(), "dist");
  const context = await chromium.launchPersistentContext(
    test.info().outputPath("profile"),
    {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    },
  );
  let interceptedHealthChecks = 0;
  await context.route(`${DEFAULT_BACKEND_URL}/api/health`, async (route) => {
    interceptedHealthChecks += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
  try {
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent("serviceworker");
    }
    const extensionId = new URL(serviceWorker.url()).hostname;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(page).toHaveTitle(/Provenance Lens/u);
    await expect(
      page.getByRole("button", { name: "Pick an image on this page" }),
    ).toBeVisible();
    const popupModeSummary = page.locator("#verification-mode-summary");
    await expect(popupModeSummary).toContainText(/^(Website|API) mode:/u);
    const popupModeText = (await popupModeSummary.textContent()) ?? "";
    const hasBundledClient = popupModeText.startsWith("API mode:");
    await expect(popupModeSummary).toContainText(
      hasBundledClient ? "API mode:" : "Website mode:",
    );
    await expect(
      page.getByRole("button", { name: "Grant optional access" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Cancel verification" }),
    ).toBeHidden();

    const settingsPagePromise = context.waitForEvent("page");
    await page.getByRole("button", { name: "Settings" }).click();
    const settingsPage = await settingsPagePromise;
    await settingsPage.waitForLoadState("domcontentloaded");
    await expect(settingsPage).toHaveTitle(/Provenance Lens settings/u);
    const bundledClientDisclosure = settingsPage.locator(
      "#bundled-client-disclosure",
    );
    await expect(bundledClientDisclosure).toHaveCount(1);
    if (hasBundledClient) {
      await expect(bundledClientDisclosure).toBeVisible();
      await expect(settingsPage.locator("#connection-status")).toHaveText(
        "The bundled production connection is ready.",
      );
      expect(interceptedHealthChecks).toBeGreaterThan(0);
    } else {
      await expect(bundledClientDisclosure).toBeHidden();
      expect(interceptedHealthChecks).toBe(0);
    }
    await expect(settingsPage.locator("#verification-mode")).toHaveValue(
      hasBundledClient ? "api" : "website",
    );
    await expect(settingsPage.locator("#backend-url")).toHaveValue(
      DEFAULT_BACKEND_URL,
    );
    const clientToken = settingsPage.locator("#client-token");
    const backendPermission = settingsPage.locator(
      "#request-backend-permission",
    );
    await expect(backendPermission).toBeVisible();
    if (hasBundledClient) {
      await expect(clientToken).toBeDisabled();
      await expect(clientToken).toHaveValue("");
    } else {
      await expect(clientToken).toBeEnabled();
    }
    await settingsPage.locator("#verification-mode").selectOption("api");
    await expect(settingsPage.locator("#api-mode-disclosure")).toBeVisible();
    await expect(settingsPage.locator("#website-mode-disclosure")).toBeHidden();
    await settingsPage.locator("#verification-mode").selectOption("website");
    await expect(
      settingsPage.locator("#website-mode-disclosure"),
    ).toBeVisible();
    await expect(settingsPage.locator("#api-mode-disclosure")).toBeHidden();

    await settingsPage.locator("#backend-url").fill("https://verify.example");
    await expect(backendPermission).toBeVisible();
    await expect(clientToken).toBeEnabled();
    await expect(bundledClientDisclosure).toBeHidden();
    await settingsPage.locator("#backend-url").fill(DEFAULT_BACKEND_URL);
    await expect(backendPermission).toBeVisible();
    if (hasBundledClient) {
      await expect(clientToken).toBeDisabled();
      await expect(clientToken).toHaveValue("");
      await expect(bundledClientDisclosure).toBeVisible();
    } else {
      await expect(clientToken).toBeEnabled();
      await expect(bundledClientDisclosure).toBeHidden();
    }

    await settingsPage.setViewportSize({ width: 1280, height: 900 });
    const columns = settingsPage.locator("#settings-form > .settings-column");
    const firstCard = await columns
      .nth(0)
      .locator(".card")
      .first()
      .boundingBox();
    const secondCard = await columns
      .nth(1)
      .locator(".card")
      .first()
      .boundingBox();
    expect(firstCard).not.toBeNull();
    expect(secondCard).not.toBeNull();
    expect(Math.abs((firstCard?.y ?? 0) - (secondCard?.y ?? 0))).toBeLessThan(
      2,
    );
    expect((secondCard?.x ?? 0) - (firstCard?.x ?? 0)).toBeGreaterThan(400);

    await settingsPage.setViewportSize({ width: 700, height: 900 });
    const narrowFirstCard = await columns
      .nth(0)
      .locator(".card")
      .first()
      .boundingBox();
    const narrowSecondCard = await columns
      .nth(1)
      .locator(".card")
      .first()
      .boundingBox();
    expect(
      (narrowSecondCard?.y ?? 0) - (narrowFirstCard?.y ?? 0),
    ).toBeGreaterThan(200);

    const resultId = "123e4567-e89b-42d3-a456-426614174000";
    const record = {
      id: resultId,
      actionId: "verify-openai-provenance",
      createdAt: "2026-09-02T14:46:50.000Z",
      sourceHostname: "page.example",
      pageTitle:
        "A deliberately long page title that must wrap by words instead of one character per line",
      inputKind: "original_file",
      imageSha256: "0".repeat(64),
      result: {
        verdict: "openai_signal_detected",
        summary: "Detected signals: SynthID.",
        signals: [
          {
            type: "synthid",
            outcome: "detected",
            validationState: null,
            issuer: null,
            model: null,
            generatedAt: null,
          },
        ],
        warnings: [],
        checkedAt: "2026-09-02T14:46:50.000Z",
        requestId: resultId,
      },
      cache: null,
      errorCode: null,
      manualFallbackAvailable: false,
      screenshotFallbackAvailable: false,
    };
    await page.evaluate(async (savedRecord) => {
      await chrome.storage.local.set({
        "provenanceLens.history": [savedRecord],
      });
      await chrome.storage.session.set({
        "provenanceLens.latest": savedRecord,
      });
    }, record);
    await page.reload();

    const detailsPagePromise = context.waitForEvent("page");
    const resultDetails = page.getByRole("link", {
      name: "Show result details",
    });
    await expect(resultDetails).toHaveClass(/result-action-detected/u);
    await resultDetails.click();
    const detailsPage = await detailsPagePromise;
    await detailsPage.waitForLoadState("domcontentloaded");
    await expect(detailsPage).toHaveTitle(/Provenance Lens result/u);
    await detailsPage.setViewportSize({ width: 420, height: 900 });
    await expect(
      detailsPage.getByText("SynthID", { exact: true }),
    ).toBeVisible();
    await expect(
      detailsPage.getByText(
        "The API reported this SynthID outcome without model or generation-time metadata.",
      ),
    ).toBeVisible();
    await expect(detailsPage.getByText("Validation state")).toHaveCount(0);
    expect(
      await detailsPage.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await detailsPage.close();

    const historyPagePromise = context.waitForEvent("page");
    await page.getByRole("link", { name: "Result history" }).click();
    const historyPage = await historyPagePromise;
    await historyPage.waitForLoadState("domcontentloaded");
    await expect(historyPage).toHaveTitle(/Provenance Lens history/u);
    await historyPage.setViewportSize({ width: 420, height: 900 });
    await expect(
      historyPage.getByText("Detected signals: SynthID."),
    ).toBeVisible();
    expect(
      await historyPage.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await historyPage.close();
  } finally {
    await context.close();
  }
});

test("selects the intended image through hostile page CSS and cancels cleanly", async () => {
  const imageBytes = await readFile(
    resolve(process.cwd(), "tests/fixtures/image-fixture.png"),
  );
  const server = createServer((request, response) => {
    if (request.url === "/image.png") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(imageBytes);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <title>Picker fixture</title>
          <style>
            html { background-image: url('/decoy.png') !important; }
            [data-provenance-lens-picker="overlay"] {
              display: block !important;
              pointer-events: auto !important;
              background-image: url('/decoy.png') !important;
            }
          </style>
        </head>
        <body style="margin: 0; min-height: 100vh; background: #f8fafc;">
          <main style="padding: 80px;">
            <a id="image-link" href="/should-not-navigate">
              <img id="target-image" src="/image.png" alt="Fixture" width="320" height="180">
            </a>
            <button id="cover" type="button" style="position: absolute; left: 160px; top: 140px; width: 80px; height: 50px; opacity: .01;">Cover</button>
          </main>
          <script>
            window.__hostViewerActivations = 0;
            const imageLink = document.querySelector('#image-link');
            for (const eventType of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
              imageLink?.addEventListener(eventType, (event) => {
                window.__hostViewerActivations += 1;
                if (eventType === 'click') event.preventDefault();
              });
            }
          </script>
        </body>
      </html>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The picker fixture server did not start.");
  }

  const browser = await chromium.launch({
    channel: "chromium",
    headless: true,
  });
  try {
    const targetPage = await browser.newPage();
    await targetPage.goto(`http://127.0.0.1:${address.port}/`);
    await targetPage.evaluate(() => {
      const listeners: Array<(message: unknown) => void> = [];
      const sentMessages: unknown[] = [];
      Object.defineProperty(chrome, "runtime", {
        configurable: true,
        value: {
          onMessage: {
            addListener(listener: (message: unknown) => void): void {
              listeners.push(listener);
            },
          },
          sendMessage(message: unknown): Promise<void> {
            sentMessages.push(message);
            return Promise.resolve();
          },
        },
      });
      Object.defineProperty(globalThis, "__pickerTestListeners", {
        configurable: true,
        value: listeners,
      });
      Object.defineProperty(globalThis, "__pickerTestSentMessages", {
        configurable: true,
        value: sentMessages,
      });
    });
    await targetPage.addScriptTag({
      path: resolve(process.cwd(), "dist/picker.js"),
      type: "module",
    });
    await targetPage.waitForFunction(
      (runtimeVersion) =>
        (
          window as Window & {
            __provenanceLensPickerInstalled?: boolean | string;
          }
        ).__provenanceLensPickerInstalled === runtimeVersion,
      PICKER_RUNTIME_VERSION,
    );
    const pickerListenerCount = await targetPage.evaluate(() => {
      const scope = globalThis as typeof globalThis & {
        __pickerTestListeners?: Array<(message: unknown) => void>;
      };
      return scope.__pickerTestListeners?.length ?? 0;
    });
    expect(pickerListenerCount).toBe(1);
    const triggeredListeners = await targetPage.evaluate((runtimeVersion) => {
      const scope = globalThis as typeof globalThis & {
        __pickerTestListeners?: Array<(message: unknown) => void>;
      };
      const listeners = scope.__pickerTestListeners ?? [];
      for (const listener of listeners) {
        listener({
          type: "page-bind",
          runtimeVersion,
          sessionToken: "123e4567-e89b-42d3-a456-426614174000",
        });
        listener({
          type: "picker-start",
          runtimeVersion,
          sessionToken: "123e4567-e89b-42d3-a456-426614174000",
        });
      }
      return listeners.length;
    }, PICKER_RUNTIME_VERSION);
    expect(triggeredListeners).toBe(1);

    const overlay = targetPage.locator(
      '[data-provenance-lens-picker="overlay"]',
    );
    await expect(overlay).toBeAttached();
    const imageBox = await targetPage.locator("#target-image").boundingBox();
    expect(imageBox).not.toBeNull();
    await targetPage.mouse.move(
      (imageBox?.x ?? 0) + 120,
      (imageBox?.y ?? 0) + 90,
    );
    await expect(overlay).toHaveAttribute(
      "aria-label",
      /Image · 320 × 180 px · Click to select · Esc to cancel/u,
    );
    await expect(overlay).toHaveCSS("pointer-events", "none");

    const imageX = (imageBox?.x ?? 0) + 120;
    const imageY = (imageBox?.y ?? 0) + 90;
    await targetPage.mouse.move(imageX, imageY);
    await targetPage.mouse.down();
    await targetPage.mouse.up();
    await expect(overlay).toHaveCount(0);
    await expect(targetPage).toHaveURL(`http://127.0.0.1:${address.port}/`);
    await expect
      .poll(() =>
        targetPage.evaluate(
          () =>
            (window as Window & { __hostViewerActivations?: number })
              .__hostViewerActivations ?? 0,
        ),
      )
      .toBe(0);
    await expect
      .poll(() =>
        targetPage.evaluate(() => {
          const scope = globalThis as typeof globalThis & {
            __pickerTestSentMessages?: Array<{
              type?: string;
              selection?: { url?: string };
            }>;
          };
          return scope.__pickerTestSentMessages?.find(
            (message) => message.type === "picker-selected",
          )?.selection?.url;
        }),
      )
      .toBe(`http://127.0.0.1:${address.port}/image.png`);

    await targetPage.evaluate((runtimeVersion) => {
      const scope = globalThis as typeof globalThis & {
        __pickerTestListeners?: Array<(message: unknown) => void>;
      };
      for (const listener of scope.__pickerTestListeners ?? []) {
        listener({
          type: "page-bind",
          runtimeVersion,
          sessionToken: "123e4567-e89b-42d3-a456-426614174000",
        });
        listener({
          type: "picker-start",
          runtimeVersion,
          sessionToken: "123e4567-e89b-42d3-a456-426614174000",
        });
      }
    }, PICKER_RUNTIME_VERSION);
    const restartedOverlay = targetPage.locator(
      '[data-provenance-lens-picker="overlay"]',
    );
    await expect(restartedOverlay).toBeAttached();
    await targetPage.mouse.move(
      (imageBox?.x ?? 0) + 20,
      (imageBox?.y ?? 0) + 20,
    );
    await expect(restartedOverlay).toHaveAttribute(
      "aria-label",
      /Image · 320 × 180 px · Click to select · Esc to cancel/u,
    );

    await targetPage.keyboard.press("Escape");
    await expect(restartedOverlay).toHaveCount(0);
    await expect(targetPage).toHaveURL(`http://127.0.0.1:${address.port}/`);
    await expect
      .poll(() =>
        targetPage.evaluate(() => {
          const scope = globalThis as typeof globalThis & {
            __pickerTestSentMessages?: unknown[];
          };
          return scope.__pickerTestSentMessages ?? [];
        }),
      )
      .toContainEqual({
        type: "picker-cancelled",
        sessionToken: "123e4567-e89b-42d3-a456-426614174000",
      });

    await targetPage.mouse.click(
      (imageBox?.x ?? 0) + 20,
      (imageBox?.y ?? 0) + 20,
    );
    await expect
      .poll(() =>
        targetPage.evaluate(
          () =>
            (window as Window & { __hostViewerActivations?: number })
              .__hostViewerActivations ?? 0,
        ),
      )
      .toBeGreaterThan(0);
  } finally {
    await browser.close();
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) rejectClose(error);
        else resolveClose();
      });
    });
  }
});
