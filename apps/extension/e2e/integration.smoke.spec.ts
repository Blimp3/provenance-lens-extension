import { chromium, expect, test, type Route } from "@playwright/test";
import {
  DOWNLOAD_ACTION_ID,
  VERIFICATION_POLICY_VERSION,
  sha256Hex,
} from "@provenance-lens/shared";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const INTEGRATION_BACKEND_URL =
  "https://private-media-downloader.yellow-salad-bfde.workers.dev";

type OperationInput = {
  version: 1;
  operationId: string;
  action: "check" | "download";
  media: {
    mediaSha256: string;
    byteLength: number;
    mimeType: "image/png";
    inputKind: "original";
    audioDurationSeconds: null;
    segment: null;
    fullSourceSha256: null;
  };
  forceRecheck: false;
};

type OperationStatus = Record<string, unknown> & {
  operationId: string;
  action: "check" | "download";
};

const accountId = "account-e2e";
const sessionId = "session-e2e";
const accessToken = "access-token-e2e";
const refreshToken = "refresh-token-e2e";
const operationIdPattern = /^[0-9a-f-]{36}$/u;

function fixtureTime(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function json(route: Route, value: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
}

function archive(mediaSha256: string) {
  return {
    deliveryState: "confirmed",
    documentReceipt: {
      botId: "123456789",
      chatId: "987654321",
      messageId: "1001",
      fileId: "telegram-e2e-file",
    },
    integrityState: "verified",
    roundTripSha256: mediaSha256,
    error: null,
    retryReady: false,
  };
}

function pendingArchive() {
  return {
    deliveryState: "pending",
    documentReceipt: null,
    integrityState: "not_checked",
    roundTripSha256: null,
    error: null,
    retryReady: false,
  };
}

function completeStatus(
  input: OperationInput,
  sequence: number,
): OperationStatus {
  const requestedAt = fixtureTime(-1_000);
  const checkedAt = fixtureTime(0);
  const result =
    input.action === "check"
      ? {
          resultRef: `result-e2e-${sequence}`,
          accountId,
          mediaSha256: input.media.mediaSha256,
          verificationPolicyVersion: VERIFICATION_POLICY_VERSION,
          resultSchemaVersion: 1,
          originallyCheckedAt: checkedAt,
          cacheSource: "fresh",
          evidence: {
            verdict: "no_supported_openai_signal",
            summary:
              "Fresh connected check; no supported provenance signal was detected.",
            signals: [],
            warnings: [],
            checkedAt,
            requestId: `00000000-0000-4000-8000-00000000000${sequence}`,
          },
        }
      : null;
  return {
    version: 1,
    operationId: input.operationId,
    accountId,
    action: input.action,
    state: "completed",
    requestedAt,
    expiresAt: fixtureTime(86_400_000),
    mediaSha256: input.media.mediaSha256,
    segment: null,
    envelope: {
      ...input,
      accountId,
      requestedAt,
      result,
      archive: archive(input.media.mediaSha256),
      historySync: {
        state: "synced",
        historyId: `33333333-3333-4333-8333-33333333333${sequence}`,
        error: null,
      },
    },
    archive: archive(input.media.mediaSha256),
    error: null,
  };
}

function awaitingStatus(input: OperationInput): OperationStatus {
  return {
    version: 1,
    operationId: input.operationId,
    accountId,
    action: input.action,
    state: "awaiting_upload",
    requestedAt: fixtureTime(-1_000),
    expiresAt: fixtureTime(86_400_000),
    mediaSha256: input.media.mediaSha256,
    segment: null,
    envelope: null,
    archive: pendingArchive(),
    error: null,
  };
}

test("pairs DigiBot, separates image Check and Download operations, and renders connected History", async () => {
  const imageBytes = await readFile(
    resolve(process.cwd(), "tests/fixtures/image-fixture.png"),
  );
  const imageSha256 = await sha256Hex(imageBytes);

  const operationInputs: OperationInput[] = [];
  const operationStatuses = new Map<string, OperationStatus>();
  let verificationCalls = 0;
  let sequence = 0;
  const context = await chromium.launchPersistentContext(
    test.info().outputPath("profile"),
    {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${resolve(process.cwd(), "dist")}`,
        `--load-extension=${resolve(process.cwd(), "dist")}`,
      ],
    },
  );
  await context.route(`${INTEGRATION_BACKEND_URL}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/fixture") {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: '<!doctype html><html lang="en"><head><title>Integration fixture</title></head><body><img id="target-image" src="/image.png" alt="Fixture" width="320" height="180"></body></html>',
      });
      return;
    }
    if (path === "/image.png") {
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        body: imageBytes,
      });
      return;
    }
    if (path === "/api/integration/pairings" && request.method() === "POST") {
      await json(
        route,
        {
          pairId: "pair-e2e",
          confirmationCode: "482731",
          expiresAt: fixtureTime(300_000),
        },
        201,
      );
      return;
    }
    if (
      path === "/api/integration/pairings/pair-e2e/exchange" &&
      request.method() === "POST"
    ) {
      await json(route, {
        tokenType: "Bearer",
        accountId,
        sessionId,
        accessToken,
        accessExpiresAt: fixtureTime(900_000),
        refreshToken,
        refreshExpiresAt: fixtureTime(7 * 86_400_000),
        absoluteExpiresAt: fixtureTime(30 * 86_400_000),
      });
      return;
    }
    if (path === "/api/integration/operations" && request.method() === "POST") {
      const input = JSON.parse(request.postData() ?? "{}") as OperationInput;
      expect(input.version).toBe(1);
      expect(input.media.mediaSha256).toBe(imageSha256);
      expect(operationIdPattern.test(input.operationId)).toBe(true);
      operationInputs.push(input);
      const status = awaitingStatus(input);
      operationStatuses.set(input.operationId, status);
      await json(route, status, 201);
      return;
    }
    const upload = path.match(
      /^\/api\/integration\/operations\/([^/]+)\/media$/u,
    );
    if (upload && request.method() === "PUT") {
      const input = operationInputs.find(
        (candidate) => candidate.operationId === upload[1],
      );
      if (!input) {
        await json(
          route,
          {
            error: {
              code: "not_found",
              message: "Unknown operation",
              retryable: false,
            },
          },
          404,
        );
        return;
      }
      sequence += 1;
      const status = completeStatus(input, sequence);
      operationStatuses.set(input.operationId, status);
      await json(route, status, 202);
      return;
    }
    if (
      path === "/api/verify-image" ||
      path === "/api/verify-audio" ||
      path === "/api/verify-provenance"
    ) {
      verificationCalls += 1;
      await json(
        route,
        {
          error: {
            code: "unexpected_verification",
            message: "Provider verification was not expected in this flow.",
            retryable: false,
          },
        },
        500,
      );
      return;
    }
    if (path === "/api/health") {
      await json(route, { ok: true });
      return;
    }
    if (path === "/api/integration/history" && request.method() === "GET") {
      await json(route, {
        operations: [...operationStatuses.values()],
        nextCursor: null,
      });
      return;
    }
    if (path === "/api/integration/stats" && request.method() === "GET") {
      await json(route, {
        period: url.searchParams.get("period") ?? "all",
        since: null,
        asOf: fixtureTime(0),
        checksRequested: operationInputs.filter(
          (input) => input.action === "check",
        ).length,
        checksCompleted: operationInputs.filter(
          (input) => input.action === "check",
        ).length,
        checksFailed: 0,
        freshChecks: operationInputs.filter((input) => input.action === "check")
          .length,
        cachedChecks: 0,
        downloadsRequested: operationInputs.filter(
          (input) => input.action === "download",
        ).length,
        downloadsConfirmed: operationInputs.filter(
          (input) => input.action === "download",
        ).length,
        downloadsFailed: 0,
        uniqueMedia: operationInputs.length ? 1 : 0,
        savedOriginals: operationInputs.length,
        unresolvedArchives: 0,
        legacyDownloads: 0,
      });
      return;
    }
    await json(route, { ok: true });
  });

  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).hostname;
    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${extensionId}/settings.html`);
    await expect(settings.locator("#integration-status")).toHaveText(
      "DigiBot is not connected.",
    );
    await settings.locator("#start-pairing").click();
    await expect(settings.locator("#integration-command")).toHaveText(
      "/link pair-e2e",
    );
    await expect(settings.locator("#integration-code")).toHaveText("482731");
    await expect(settings.locator("#integration-pairing")).toBeVisible();
    await settings.locator("#complete-pairing").click();
    await expect(settings.locator("#integration-status")).toHaveText(
      /DigiBot is connected/u,
    );
    await expect(settings.locator("#disconnect-integration")).toBeVisible();
    await expect(settings.locator("#integration-pairing")).toBeHidden();

    const targetPage = await context.newPage();
    await targetPage.goto(`${INTEGRATION_BACKEND_URL}/fixture`);
    const image = targetPage.locator("#target-image");
    const imageBox = await image.boundingBox();
    expect(imageBox).not.toBeNull();

    const startAction = async (actionId: string): Promise<void> => {
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      const actionButton = popup.locator(
        `button[data-action-id="${actionId}"]`,
      );
      await expect(actionButton).toBeVisible();
      await expect(actionButton).toBeEnabled();
      await targetPage.bringToFront();
      const targetTab = await worker.evaluate(async (targetUrl) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((candidate) => candidate.url === targetUrl);
        if (tab?.id === undefined) throw new Error("Target tab was not found.");
        await chrome.tabs.update(tab.id, { active: true });
        if (tab.windowId !== undefined) {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
        return { id: tab.id, active: true };
      }, targetPage.url());
      expect(targetTab.active).toBe(true);
      await popup.evaluate((id) => {
        const button = document.querySelector<HTMLButtonElement>(
          `button[data-action-id="${id}"]`,
        );
        if (!button) throw new Error(`Action button ${id} was not found.`);
        button.click();
      }, actionId);
      await popup.close().catch(() => undefined);
      const overlay = targetPage.locator(
        '[data-provenance-lens-picker="overlay"]',
      );
      await expect(overlay).toBeAttached();
      await targetPage.mouse.click(
        (imageBox?.x ?? 0) + 80,
        (imageBox?.y ?? 0) + 80,
      );
      await expect(overlay).toHaveCount(0);
    };

    await startAction("verify-openai-provenance");
    await expect.poll(() => operationInputs.length).toBe(1);
    await expect.poll(() => operationStatuses.size).toBe(1);
    await expect
      .poll(() =>
        targetPage.locator('[data-provenance-lens-toast="true"]').count(),
      )
      .toBeGreaterThan(0);

    await startAction(DOWNLOAD_ACTION_ID);
    await expect.poll(() => operationInputs.length).toBe(2);
    await expect.poll(() => operationStatuses.size).toBe(2);
    expect(operationInputs[0]?.action).toBe("check");
    expect(operationInputs[1]?.action).toBe("download");
    expect(operationInputs[0]?.operationId).not.toBe(
      operationInputs[1]?.operationId,
    );
    expect(verificationCalls).toBe(0);

    const history = await context.newPage();
    await history.goto(`chrome-extension://${extensionId}/history.html`);
    await expect(history.locator("#history-status")).toContainText(
      "2 connected operations shown.",
    );
    await expect(history.locator("#history-stats")).toContainText("1 fresh");
    await expect(history.locator("#history-stats")).toContainText(
      "Downloads 1/1",
    );
    await expect(history.locator("#history-list")).toContainText("Check");
    await expect(history.locator("#history-list")).toContainText("Download");
    await expect(history.locator("#history-list")).toContainText(
      "Fresh connected check",
    );
    await expect(history.locator("#history-list")).toContainText(
      "Telegram copy saved.",
    );
  } finally {
    await context.close();
  }
});
