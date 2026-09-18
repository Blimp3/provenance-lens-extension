import type { NormalizedProvenanceResult } from "@provenance-lens/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getLatestRecord: vi.fn(),
  getWindowLatestRecord: vi.fn(),
  getOptionalAccessState: vi.fn(),
  getSettings: vi.fn(),
  getWorkflowState: vi.fn(),
  optionalAccessStatusText: vi.fn(),
  sendMessage: vi.fn().mockResolvedValue(undefined),
}));

type TestVerdict =
  "openai_signal_detected" | "no_supported_openai_signal" | "indeterminate";

function latestRecord(
  verdict: TestVerdict,
  id = "123e4567-e89b-42d3-a456-426614174000",
): {
  id: string;
  result: NormalizedProvenanceResult;
} {
  return {
    id,
    result: {
      verdict,
      summary:
        verdict === "openai_signal_detected"
          ? "Detected signals: SynthID."
          : verdict === "no_supported_openai_signal"
            ? "No supported OpenAI provenance signal was detected."
            : "The image could not be verified.",
      signals:
        verdict === "openai_signal_detected"
          ? [
              {
                type: "synthid",
                outcome: "detected",
                validationState: null,
                issuer: null,
                model: null,
                generatedAt: null,
              },
            ]
          : [],
      warnings: [],
      checkedAt: "2026-09-02T14:46:50.000Z",
      requestId: "223e4567-e89b-42d3-a456-426614174000",
    },
  };
}

vi.mock("../../src/actions/registry.js", () => ({
  ACTION_REGISTRY: [
    {
      id: "verify-openai-provenance",
      triggerLabel: "Pick an image on this page",
      description: "Pick one image to verify.",
    },
  ],
}));
vi.mock("../../src/storage.js", () => ({
  STORAGE_KEYS: {
    history: "history",
    latest: "latest",
    popupLatestByWindow: "popupLatestByWindow",
    settings: "settings",
    workflow: "workflow",
  },
  getLatestRecord: mocks.getLatestRecord,
  getWindowLatestRecord: mocks.getWindowLatestRecord,
  getSettings: mocks.getSettings,
  getWorkflowState: mocks.getWorkflowState,
}));
vi.mock("../../src/ui/optional-access.js", () => ({
  getOptionalAccessState: mocks.getOptionalAccessState,
  optionalAccessStatusText: mocks.optionalAccessStatusText,
}));

describe("popup optional-access setup card", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = `
      <div id="action-list"></div>
      <p id="workflow-status"></p>
      <section id="latest-card"></section>
      <div id="latest-result"></div>
      <a id="latest-details"></a>
      <button id="cancel-verification"></button>
      <button id="grant-optional-access"></button>
      <p id="optional-access-status"></p>
      <section id="optional-access-card"></section>
      <p id="verification-mode-summary"></p>
      <button id="open-settings"></button>
    `;
    mocks.getLatestRecord.mockResolvedValue(null);
    mocks.getWindowLatestRecord.mockResolvedValue(null);
    mocks.getSettings.mockResolvedValue({ verificationMode: "website" });
    mocks.getWorkflowState.mockResolvedValue({
      status: "idle",
      message: "Ready",
    });
    mocks.optionalAccessStatusText.mockReturnValue(
      "Full optional access is ready.",
    );
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        permissions: {
          onAdded: { addListener: vi.fn() },
          onRemoved: { addListener: vi.fn() },
        },
        runtime: {
          openOptionsPage: vi.fn().mockResolvedValue(undefined),
          sendMessage: mocks.sendMessage,
        },
        storage: { onChanged: { addListener: vi.fn() } },
        windows: {
          getCurrent: vi.fn().mockResolvedValue({ id: 7 }),
        },
      },
    });
  });

  async function loadPopup(
    state: {
      allSites: boolean;
      downloads: boolean;
      complete: boolean;
    },
    latest: unknown = null,
    windowLatest: unknown = null,
  ): Promise<HTMLElement> {
    mocks.getOptionalAccessState.mockResolvedValue(state);
    mocks.getLatestRecord.mockResolvedValue(latest);
    mocks.getWindowLatestRecord.mockResolvedValue(windowLatest);
    await import("../../src/ui/popup.js");
    const card = document.getElementById("optional-access-card");
    if (!card) throw new Error("Missing optional-access card");
    await vi.waitFor(() =>
      expect(mocks.getOptionalAccessState).toHaveBeenCalled(),
    );
    return card;
  }

  it("hides the setup card after all optional access is granted", async () => {
    const card = await loadPopup({
      allSites: true,
      downloads: true,
      complete: true,
    });
    expect(card.hidden).toBe(true);
  });

  it("keeps the setup card visible while optional access is incomplete", async () => {
    const card = await loadPopup({
      allSites: true,
      downloads: false,
      complete: false,
    });
    expect(card.hidden).toBe(false);
  });

  it.each([
    ["openai_signal_detected", "result-action-detected"],
    ["no_supported_openai_signal", "result-action-no-signal"],
    ["indeterminate", "secondary"],
  ] as const)(
    "uses the %s result action style for the latest result",
    async (verdict, expectedClass) => {
      await loadPopup(
        { allSites: true, downloads: true, complete: true },
        latestRecord(verdict),
      );
      const details = document.getElementById("latest-details");
      if (!(details instanceof HTMLAnchorElement))
        throw new Error("Missing latest result details link");
      await vi.waitFor(() =>
        expect(details.textContent).toBe("Show result details"),
      );
      expect(details.className).toBe(`button ${expectedClass}`);
      expect(document.getElementById("latest-result")?.textContent).toContain(
        verdict === "openai_signal_detected"
          ? "OpenAI provenance detected"
          : verdict === "no_supported_openai_signal"
            ? "No supported OpenAI signal detected"
            : "The image could not be verified",
      );
    },
  );

  it("keeps an invalid saved result action neutral", async () => {
    await loadPopup(
      { allSites: true, downloads: true, complete: true },
      {
        id: "123e4567-e89b-42d3-a456-426614174000",
        result: { verdict: "unexpected" },
      },
    );
    const details = document.getElementById("latest-details");
    if (!(details instanceof HTMLAnchorElement))
      throw new Error("Missing latest result details link");
    await vi.waitFor(() =>
      expect(details.textContent).toBe("Show result details"),
    );
    expect(details.className).toBe("button secondary");
    expect(document.getElementById("latest-result")?.textContent).toContain(
      "The saved result is unavailable.",
    );
  });

  it("prefers the current window result for the details link and action color", async () => {
    const windowRecord = latestRecord(
      "openai_signal_detected",
      "323e4567-e89b-42d3-a456-426614174000",
    );
    await loadPopup(
      { allSites: true, downloads: true, complete: true },
      latestRecord(
        "no_supported_openai_signal",
        "423e4567-e89b-42d3-a456-426614174000",
      ),
      windowRecord,
    );

    const details = document.getElementById("latest-details");
    if (!(details instanceof HTMLAnchorElement))
      throw new Error("Missing latest result details link");
    await vi.waitFor(() =>
      expect(details.getAttribute("href")).toBe(
        `details.html?id=${encodeURIComponent(windowRecord.id)}`,
      ),
    );
    expect(details.className).toBe("button result-action-detected");
    expect(document.getElementById("latest-result")?.textContent).toContain(
      "OpenAI provenance detected",
    );
    expect(mocks.getWindowLatestRecord).toHaveBeenCalledWith(7);
  });

  it("closes the action popup after handing off the picker request", async () => {
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    await loadPopup({ allSites: true, downloads: true, complete: true });

    const actionButton = document.querySelector<HTMLButtonElement>(
      "#action-list button",
    );
    expect(actionButton).not.toBeNull();
    actionButton?.click();

    await vi.waitFor(() =>
      expect(mocks.sendMessage).toHaveBeenCalledWith({
        type: "start-action",
        actionId: "verify-openai-provenance",
        trigger: "popup",
      }),
    );
    expect(close).toHaveBeenCalledTimes(1);
  });
});
