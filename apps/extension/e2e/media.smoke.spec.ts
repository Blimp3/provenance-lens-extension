import { chromium, expect, test } from "@playwright/test";
import {
  DEFAULT_BACKEND_URL,
  VERIFICATION_POLICY_VERSION,
  sha256Hex,
} from "@provenance-lens/shared";
import { resolve } from "node:path";

function wav(seconds: number): Buffer {
  const sampleRate = 8_000;
  const dataSize = sampleRate * seconds * 2;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36 + dataSize, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(dataSize, 40);
  return bytes;
}

test("checks exact audio bytes, rejects long audio locally, and explains C2PA trust", async () => {
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
  const original = wav(1);
  const requestId = "123e4567-e89b-42d3-a456-426614174111";
  const now = new Date().toISOString();
  const response = {
    result: {
      verdict: "no_supported_openai_signal",
      summary:
        "No supported OpenAI audio provenance signal was detected. This does not prove that the audio is human-recorded.",
      signals: [
        {
          type: "synthid",
          outcome: "not_detected",
          validationState: null,
          issuer: null,
          model: null,
          generatedAt: null,
        },
      ],
      warnings: [],
      checkedAt: now,
      requestId,
    },
    cache: {
      source: "fresh",
      originallyCheckedAt: now,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      verificationPolicyVersion: VERIFICATION_POLICY_VERSION,
      resultSchemaVersion: 1,
    },
  };
  let uploads = 0;
  let lookups = 0;
  await context.route(`${DEFAULT_BACKEND_URL}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body: unknown = { status: "ok" };
    if (path === "/api/cache/lookup") {
      lookups += 1;
      body = {
        hit: false,
        verificationPolicyVersion: VERIFICATION_POLICY_VERSION,
      };
    } else if (path === "/api/verify-audio") {
      uploads += 1;
      const multipart = await new Request(request.url(), {
        method: "POST",
        headers: request.headers(),
        body: new Uint8Array(request.postDataBuffer() ?? Buffer.alloc(0))
          .buffer,
      }).formData();
      const file = multipart.get("file");
      expect(file).toBeInstanceOf(File);
      expect(Buffer.from(await (file as File).arrayBuffer())).toEqual(original);
      expect(multipart.get("imageSha256")).toBe(await sha256Hex(original));
      expect(multipart.get("validatedMimeType")).toBe("audio/wav");
      body = response;
    } else {
      expect(path).toBe("/api/health");
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).hostname;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(
      page.getByRole("button", { name: "Check audio or video segment" }),
    ).toBeVisible();
    await page.evaluate(async (backendBaseUrl) => {
      await chrome.storage.local.set({
        "provenanceLens.settings": {
          verificationMode: "api",
          acknowledgedVerificationModes: [],
          backendBaseUrl,
          clientToken: "synthetic-test-client",
          historyRetention: 20,
          screenshotFallbackEnabled: false,
          includePageTitle: true,
          debugMode: false,
          localCacheLimit: 100,
          disclosureVersion: 2,
        },
      });
    }, DEFAULT_BACKEND_URL);
    const audioPagePromise = context.waitForEvent("page");
    await page
      .getByRole("button", { name: "Check audio or video segment" })
      .click();
    const audioPage = await audioPagePromise;
    await audioPage.waitForLoadState("domcontentloaded");
    await expect(audioPage).toHaveTitle("Provenance Lens audio check");
    await audioPage.locator("#audio-file").setInputFiles({
      name: "sample.wav",
      mimeType: "audio/wav",
      buffer: original,
    });
    await expect(audioPage.locator("#api-acknowledgement")).toBeVisible();
    await audioPage.locator("#api-acknowledgement").check();
    await audioPage
      .getByRole("button", { name: "Check audio", exact: true })
      .click();
    await expect(audioPage.locator("#audio-status")).toContainText(
      "Audio check complete",
    );
    expect(uploads).toBe(1);
    expect(lookups).toBe(1);
    await audioPage
      .getByRole("button", { name: "Check audio", exact: true })
      .click();
    await expect(audioPage.locator("#audio-status")).toContainText(
      "Audio check complete",
    );
    expect(uploads).toBe(1);
    expect(lookups).toBe(1);

    const detailsPromise = context.waitForEvent("page");
    await audioPage.getByRole("link", { name: "Show result details" }).click();
    const details = await detailsPromise;
    await expect(
      details.getByRole("heading", {
        name: "No supported OpenAI audio signal detected",
      }),
    ).toBeVisible();
    await expect(details.getByText("Audio", { exact: true })).toBeVisible();
    await expect(
      details.getByText("human-recorded", { exact: false }).first(),
    ).toBeVisible();
    await details.setViewportSize({ width: 420, height: 900 });
    expect(
      await details.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);

    await audioPage.locator("#audio-file").setInputFiles({
      name: "too-long.wav",
      mimeType: "audio/wav",
      buffer: wav(61),
    });
    await audioPage
      .getByRole("button", { name: "Check audio", exact: true })
      .click();
    await expect(audioPage.locator("#audio-status")).toContainText(
      "60 seconds",
    );
    expect(uploads).toBe(1);
    expect(lookups).toBe(1);

    const credentialsId = "123e4567-e89b-42d3-a456-426614174222";
    const credentials = {
      status: "verified",
      signatureValid: true,
      contentBindingValid: true,
      signerTrusted: false,
      issuer: "<img src=x onerror=alert(1)> Test issuer",
      actions: [
        {
          action: "c2pa.created",
          digitalSourceType:
            "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
        },
      ],
      aiDeclaration: "generated",
      validationCodes: ["claimSignature.validated", "assertion.dataHash.match"],
      trustListVersion: "6273cdcb4f27",
    };
    await audioPage.evaluate(
      async (data) => {
        await chrome.storage.local.set({
          "provenanceLens.history": [
            {
              id: data.id,
              actionId: "verify-openai-provenance",
              createdAt: data.now,
              sourceHostname: "example.test",
              pageTitle: null,
              inputKind: "original_file",
              imageSha256: "a".repeat(64),
              result: {
                ...data.result,
                summary: "No supported OpenAI signal detected.",
                contentCredentials: data.credentials,
              },
              cache: null,
              errorCode: null,
              manualFallbackAvailable: false,
              screenshotFallbackAvailable: false,
            },
          ],
        });
      },
      { id: credentialsId, now, result: response.result, credentials },
    );
    await details.goto(
      `chrome-extension://${extensionId}/details.html?id=${credentialsId}`,
    );
    await expect(
      details.getByRole("heading", {
        name: "AI generation declared by an untrusted signer",
      }),
    ).toBeVisible();
    await expect(
      details.getByRole("heading", { name: "Content Credentials (C2PA)" }),
    ).toBeVisible();
    await expect(
      details.getByText("Signing certificate issuer", { exact: true }),
    ).toBeVisible();
    await expect(
      details.getByText(credentials.issuer, { exact: true }),
    ).toBeVisible();
    expect(await details.locator("#details-content img").count()).toBe(0);
    expect(
      await details.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  } finally {
    await context.close();
  }
});
