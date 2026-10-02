import type { NormalizedProvenanceResult } from "@provenance-lens/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getLatestRecord: vi.fn(),
  getWindowLatestRecord: vi.fn(),
  getOptionalAccessState: vi.fn(),
  getSettings: vi.fn(),
  getWorkflowState: vi.fn(),
  isIntegrationConnected: vi.fn(),
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
      triggerLabel: "Verify an image on this page",
      description: "Pick one image to verify.",
      inputType: "image-file",
    },
    {
      id: "send-page-link",
      triggerLabel: "Send this page's link to Telegram",
      description: "Send only this page's link to DigiBot.",
      inputType: "page-link",
    },
    {
      id: "pick-video-link",
      triggerLabel: "Pick a video on this page",
      description: "Click a post with a video.",
      inputType: "video-pick",
    },
  ],
}));
vi.mock("../../src/integration-client.js", () => ({
  isIntegrationConnected: mocks.isIntegrationConnected,
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
    mocks.isIntegrationConnected.mockResolvedValue(false);
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

  function pageLinkButton(): HTMLButtonElement {
    const button = document.querySelector<HTMLButtonElement>(
      '#action-list button[data-action-id="send-page-link"]',
    );
    if (!button) throw new Error("Missing page-link button");
    return button;
  }

  function pickButton(): HTMLButtonElement {
    const button = document.querySelector<HTMLButtonElement>(
      '#action-list button[data-action-id="pick-video-link"]',
    );
    if (!button) throw new Error("Missing video-pick button");
    return button;
  }

  it("disables the page-link button until DigiBot is connected", async () => {
    await loadPopup({ allSites: true, downloads: true, complete: true });
    const button = pageLinkButton();
    await vi.waitFor(() => expect(button.disabled).toBe(true));
    expect(button.title).toBe(
      "Connect DigiBot in Settings before sending a page link.",
    );
  });

  it("keeps the page-link button disabled while a link is being sent", async () => {
    mocks.isIntegrationConnected.mockResolvedValue(true);
    mocks.getWorkflowState.mockResolvedValue({
      status: "sending",
      message: "Sending this page's link to DigiBot…",
      updatedAt: new Date().toISOString(),
    });
    await loadPopup({ allSites: true, downloads: true, complete: true });
    const button = pageLinkButton();
    await vi.waitFor(() =>
      expect(document.getElementById("workflow-status")?.textContent).toBe(
        "Sending this page's link to DigiBot…",
      ),
    );
    expect(button.disabled).toBe(true);
    expect(pickButton().disabled).toBe(true);
  });

  it("re-enables the page-link button once a send is stale", async () => {
    mocks.isIntegrationConnected.mockResolvedValue(true);
    // A service worker killed mid-send leaves "sending" behind for good.
    mocks.getWorkflowState.mockResolvedValue({
      status: "sending",
      message: "Sending this page's link to DigiBot…",
      updatedAt: new Date(Date.now() - 121_000).toISOString(),
    });
    await loadPopup({ allSites: true, downloads: true, complete: true });
    const button = pageLinkButton();
    await vi.waitFor(() => expect(button.title).toContain("Send only"));
    expect(button.disabled).toBe(false);
  });

  it("keeps the page-link button disabled while an image check runs", async () => {
    mocks.isIntegrationConnected.mockResolvedValue(true);
    mocks.getWorkflowState.mockResolvedValue({
      status: "verifying",
      message: "Verifying the exact image bytes...",
      updatedAt: new Date().toISOString(),
    });
    await loadPopup({ allSites: true, downloads: true, complete: true });
    const button = pageLinkButton();
    await vi.waitFor(() => expect(button.title).toContain("Send only"));
    expect(button.disabled).toBe(true);
  });

  async function pageLinkDisabledFor(
    status: "retrieving" | "picking",
    ageMs: number,
  ): Promise<boolean> {
    mocks.isIntegrationConnected.mockResolvedValue(true);
    mocks.getWorkflowState.mockResolvedValue({
      status,
      message: "Working…",
      updatedAt: new Date(Date.now() - ageMs).toISOString(),
    });
    await loadPopup({ allSites: true, downloads: true, complete: true });
    const button = pageLinkButton();
    await vi.waitFor(() => expect(button.title).toContain("Send only"));
    return button.disabled;
  }

  it("enables the page-link button once a retrieving state is stale", async () => {
    // A service worker killed mid-check leaves the state behind for good.
    expect(await pageLinkDisabledFor("retrieving", 121_000)).toBe(false);
  });

  it("keeps the page-link button disabled during a live 90-second retrieval", async () => {
    // A connected check can retrieve for 30 s and then poll for 60 s.
    expect(await pageLinkDisabledFor("retrieving", 90_000)).toBe(true);
  });

  it("enables the page-link button while an image picker is open", async () => {
    // Closing the tab leaves "picking" behind; a live picker rewrites it.
    expect(await pageLinkDisabledFor("picking", 0)).toBe(false);
  });

  it("re-enables the page-link button when the background cannot be reached", async () => {
    mocks.isIntegrationConnected.mockResolvedValue(true);
    mocks.sendMessage.mockRejectedValueOnce(new Error("no receiver"));
    await loadPopup({ allSites: true, downloads: true, complete: true });
    const button = pageLinkButton();
    await vi.waitFor(() => expect(button.title).toContain("Send only"));
    button.click();

    expect(button.disabled).toBe(true);
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(document.getElementById("workflow-status")?.textContent).toBe(
      "The selected check could not be started.",
    );
  });

  it("keeps the popup open after sending the page link", async () => {
    mocks.isIntegrationConnected.mockResolvedValue(true);
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    await loadPopup({ allSites: true, downloads: true, complete: true });
    const button = pageLinkButton();
    await vi.waitFor(() => expect(button.title).toContain("Send only"));
    expect(button.disabled).toBe(false);
    button.click();

    // A second click must not queue a second job before DigiBot answers.
    expect(button.disabled).toBe(true);
    await vi.waitFor(() =>
      expect(mocks.sendMessage).toHaveBeenCalledWith({
        type: "start-action",
        actionId: "send-page-link",
        trigger: "popup",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(close).not.toHaveBeenCalled();
  });

  function pageLinkControls() {
    const select = document.getElementById("link-output");
    const clip = document.getElementById("link-clip-fields");
    const start = document.getElementById("link-clip-start");
    const end = document.getElementById("link-clip-end");
    const error = document.getElementById("link-output-error");
    if (
      !(select instanceof HTMLSelectElement) ||
      !(start instanceof HTMLInputElement) ||
      !(end instanceof HTMLInputElement) ||
      !clip ||
      !error
    )
      throw new Error("Missing page-link output controls");
    return {
      select,
      clip,
      start,
      end,
      error,
      button: pageLinkButton(),
      pick: pickButton(),
    };
  }

  async function connectedPopup() {
    mocks.isIntegrationConnected.mockResolvedValue(true);
    await loadPopup({ allSites: true, downloads: true, complete: true });
    const controls = pageLinkControls();
    await vi.waitFor(() =>
      expect(controls.button.title).toContain("Send only"),
    );
    expect(controls.button.disabled).toBe(false);
    expect(controls.pick.disabled).toBe(false);
    expect(controls.select.disabled).toBe(false);
    return controls;
  }

  function chooseOutput(select: HTMLSelectElement, value: string): void {
    select.value = value;
    select.dispatchEvent(new Event("change"));
  }

  async function lastSentMessage(sendsBefore: number): Promise<unknown> {
    await vi.waitFor(() =>
      expect(mocks.sendMessage).toHaveBeenCalledTimes(sendsBefore + 1),
    );
    return mocks.sendMessage.mock.lastCall?.[0];
  }

  it("sends the page link as a video by default, without options", async () => {
    const { select, clip, button } = await connectedPopup();
    expect(select.value).toBe("video");
    expect(clip.hidden).toBe(true);
    const sends = mocks.sendMessage.mock.calls.length;
    button.click();

    const message = await lastSentMessage(sends);
    expect(message).toEqual({
      type: "start-action",
      actionId: "send-page-link",
      trigger: "popup",
    });
    expect(Object.keys(message as object)).not.toContain("options");
  });

  it("sends the MP3 output when it is chosen", async () => {
    const { select, clip, button } = await connectedPopup();
    chooseOutput(select, "mp3");
    expect(clip.hidden).toBe(true);
    const sends = mocks.sendMessage.mock.calls.length;
    button.click();

    expect(await lastSentMessage(sends)).toEqual({
      type: "start-action",
      actionId: "send-page-link",
      trigger: "popup",
      options: { output: "mp3" },
    });
  });

  it("sends a clip's start and end in seconds", async () => {
    const { select, clip, start, end, error, button } = await connectedPopup();
    chooseOutput(select, "clip");
    expect(clip.hidden).toBe(false);
    start.value = "1:05";
    end.value = "2:00";
    const sends = mocks.sendMessage.mock.calls.length;
    button.click();

    expect(await lastSentMessage(sends)).toEqual({
      type: "start-action",
      actionId: "send-page-link",
      trigger: "popup",
      options: { startSeconds: 65, endSeconds: 120 },
    });
    expect(error.hidden).toBe(true);
    expect(button.disabled).toBe(true);
  });

  it("shows an inline error and sends nothing when the clip ends before it starts", async () => {
    const { select, start, end, error, button } = await connectedPopup();
    chooseOutput(select, "clip");
    start.value = "2:00";
    end.value = "2:00";
    const sends = mocks.sendMessage.mock.calls.length;
    button.click();

    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("The clip must start before it ends.");
    expect(end.getAttribute("aria-invalid")).toBe("true");
    expect(start.hasAttribute("aria-invalid")).toBe(false);
    expect(document.activeElement).toBe(end);
    expect(button.disabled).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.sendMessage).toHaveBeenCalledTimes(sends);

    // Changing the output is the only other thing that clears the error.
    chooseOutput(select, "video");
    expect(error.hidden).toBe(true);
    expect(error.textContent).toBe("");
    expect(start.hasAttribute("aria-invalid")).toBe(false);
    expect(end.hasAttribute("aria-invalid")).toBe(false);
    chooseOutput(select, "clip");
    button.click();
    expect(error.hidden).toBe(false);
    expect(end.getAttribute("aria-invalid")).toBe("true");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.sendMessage).toHaveBeenCalledTimes(sends);

    // Editing the field clears the error; a valid range then sends.
    end.value = "3:00";
    end.dispatchEvent(new Event("input"));
    expect(error.hidden).toBe(true);
    expect(end.hasAttribute("aria-invalid")).toBe(false);
    button.click();
    expect(await lastSentMessage(sends)).toMatchObject({
      options: { startSeconds: 120, endSeconds: 180 },
    });
  });

  it("rejects a clip bound that is not a clock value", async () => {
    const { select, start, end, error, button } = await connectedPopup();
    chooseOutput(select, "clip");
    start.value = "1:5";
    end.value = "2:00";
    const sends = mocks.sendMessage.mock.calls.length;
    button.click();

    expect(error.textContent).toBe(
      "Enter the start and end as ss, m:ss or h:mm:ss.",
    );
    expect(start.getAttribute("aria-invalid")).toBe("true");
    expect(end.hasAttribute("aria-invalid")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.sendMessage).toHaveBeenCalledTimes(sends);
  });

  it("sends a picked video's link with the chosen output and closes the popup", async () => {
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    const { select, button, pick } = await connectedPopup();
    expect(button.nextElementSibling).toBe(pick);
    expect(pick.className).toBe("secondary");
    expect(pick.title).toBe(
      "Click a post with a video on this page; only its link is sent to your linked DigiBot account, with the output chosen above.",
    );
    chooseOutput(select, "mp3");
    const sends = mocks.sendMessage.mock.calls.length;
    pick.click();

    expect(pick.disabled).toBe(true);
    expect(await lastSentMessage(sends)).toEqual({
      type: "start-action",
      actionId: "pick-video-link",
      trigger: "popup",
      options: { output: "mp3" },
    });
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });

  it("keeps the popup open and picks nothing while the clip is invalid", async () => {
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
    const { select, start, end, error, pick } = await connectedPopup();
    chooseOutput(select, "clip");
    start.value = "2:00";
    end.value = "1:00";
    const sends = mocks.sendMessage.mock.calls.length;
    pick.click();

    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe("The clip must start before it ends.");
    expect(pick.disabled).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.sendMessage).toHaveBeenCalledTimes(sends);
    expect(close).not.toHaveBeenCalled();
  });

  it("disables the video picker until DigiBot is connected", async () => {
    await loadPopup({ allSites: true, downloads: true, complete: true });
    const pick = pickButton();
    await vi.waitFor(() => expect(pick.disabled).toBe(true));
    expect(pick.title).toBe(
      "Connect DigiBot in Settings before picking a video.",
    );
  });

  it("keeps the output dropdown and clip fields disabled until DigiBot is connected", async () => {
    await loadPopup({ allSites: true, downloads: true, complete: true });
    const { select, start, end, button } = pageLinkControls();
    await vi.waitFor(() => expect(button.disabled).toBe(true));
    expect(select.disabled).toBe(true);
    expect(start.disabled).toBe(true);
    expect(end.disabled).toBe(true);
    expect(start.inputMode).toBe("numeric");
    expect(start.getAttribute("aria-describedby")).toBe(
      "link-clip-hint link-output-error",
    );
    expect(end.getAttribute("aria-describedby")).toBe(
      "link-clip-hint link-output-error",
    );
    expect(document.getElementById("link-output-error")?.role).toBe("alert");
  });
});
