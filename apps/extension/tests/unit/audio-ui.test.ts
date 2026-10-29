import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendHistory: vi.fn(),
  createAudioHistoryRecord: vi.fn(),
  getIntegrationSession: vi.fn(),
  getSettings: vi.fn(),
  runIntegratedAudioFileAction: vi.fn(),
  sendMessage: vi.fn(),
  startActivity: vi.fn(),
  updateActivity: vi.fn(),
  updateSettings: vi.fn(),
  verifyAudioFile: vi.fn(),
}));

vi.mock("../../src/actions/verify-openai-audio.js", () => ({
  createAudioHistoryRecord: mocks.createAudioHistoryRecord,
  verifyAudioFile: mocks.verifyAudioFile,
}));
vi.mock("../../src/actions/integration-audio.js", () => ({
  runIntegratedAudioFileAction: mocks.runIntegratedAudioFileAction,
}));
vi.mock("../../src/integration-client.js", () => ({
  getIntegrationSession: mocks.getIntegrationSession,
}));
vi.mock("../../src/storage.js", () => ({
  appendHistory: mocks.appendHistory,
  getSettings: mocks.getSettings,
  startActivity: mocks.startActivity,
  updateActivity: mocks.updateActivity,
  updateSettings: mocks.updateSettings,
}));

const apiSettings = {
  verificationMode: "api" as const,
  acknowledgedVerificationModes: [] as const,
  backendBaseUrl: "https://verify.example",
  clientToken: "client-token",
  historyRetention: 20 as const,
  screenshotFallbackEnabled: false,
  includePageTitle: true,
  debugMode: false,
  localCacheLimit: 100,
  disclosureVersion: 0,
};

const result = {
  verdict: "openai_signal_detected" as const,
  summary: "Detected signals: SynthID.",
  signals: [
    {
      type: "synthid" as const,
      outcome: "detected" as const,
      validationState: null,
      issuer: null,
      model: null,
      generatedAt: null,
    },
  ],
  warnings: [],
  checkedAt: "2026-09-01T10:00:00.000Z",
  requestId: "123e4567-e89b-42d3-a456-426614174000",
};

const record = {
  id: "223e4567-e89b-42d3-a456-426614174000",
  actionId: "verify-openai-audio" as const,
  createdAt: "2026-09-01T10:00:00.000Z",
  sourceHostname: "local file",
  pageTitle: null,
  mediaKind: "audio" as const,
  inputKind: "original_file" as const,
  imageSha256: null,
  result,
  cache: null,
  errorCode: null,
  manualFallbackAvailable: false,
  screenshotFallbackAvailable: false,
};

function renderPage(): void {
  document.body.innerHTML = `
    <form id="audio-form">
      <input id="audio-file" type="file">
      <p id="audio-status"></p>
      <div id="audio-result" hidden></div>
      <div id="api-authorization" hidden>
        <input id="api-acknowledgement" type="checkbox">
      </div>
      <p id="api-only-message" hidden>
        <a id="open-verification-mode" href="#">Verification mode</a>
      </p>
    </form>
    <button id="open-settings" type="button"></button>
  `;
}

function chooseAudioFile(): File {
  const input = document.getElementById("audio-file");
  if (!(input instanceof HTMLInputElement))
    throw new Error("Missing audio input");
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [new File(["audio"], "voice.wav", { type: "audio/wav" })],
  });
  const selected = input.files?.[0];
  if (!selected) throw new Error("Missing selected audio file");
  // The choice alone starts the check: the page has no Check button.
  input.dispatchEvent(new Event("change"));
  return selected;
}

describe("audio check authorization", () => {
  // The Web Locks the page asks for, by name.
  const lockNames: string[] = [];

  beforeEach(() => {
    vi.resetModules();
    renderPage();
    lockNames.length = 0;
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: (name: string, callback: () => Promise<void>) => {
          lockNames.push(name);
          return Promise.resolve().then(callback);
        },
      },
    });
    mocks.appendHistory.mockReset().mockResolvedValue(undefined);
    mocks.createAudioHistoryRecord.mockReset().mockReturnValue(record);
    mocks.verifyAudioFile.mockReset().mockResolvedValue({
      result,
      imageSha256: null,
      cache: null,
      errorCode: null,
    });
    mocks.updateSettings.mockReset();
    mocks.getIntegrationSession.mockReset().mockResolvedValue(null);
    mocks.runIntegratedAudioFileAction.mockReset();
    mocks.sendMessage.mockReset().mockResolvedValue(undefined);
    mocks.startActivity.mockReset().mockResolvedValue(undefined);
    mocks.updateActivity.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: { runtime: { sendMessage: mocks.sendMessage } },
    });
  });

  it("requires and persists the API acknowledgement before the first upload", async () => {
    const acknowledged = {
      ...apiSettings,
      acknowledgedVerificationModes: ["api"] as const,
      disclosureVersion: 2,
    };
    mocks.getSettings.mockResolvedValue(apiSettings);
    mocks.updateSettings.mockResolvedValue(acknowledged);
    await import("../../src/ui/audio.js");
    await vi.waitFor(() => expect(mocks.getSettings).toHaveBeenCalled());

    const authorization = document.getElementById("api-authorization");
    const checkbox = document.getElementById("api-acknowledgement");
    expect(authorization?.hidden).toBe(false);
    expect((checkbox as HTMLInputElement).required).toBe(true);
    // A file chosen before the acknowledgement waits for it.
    const file = chooseAudioFile();
    await vi.waitFor(() =>
      expect(document.getElementById("audio-status")?.textContent).toContain(
        "Acknowledge the API privacy disclosure",
      ),
    );
    expect(mocks.verifyAudioFile).not.toHaveBeenCalled();
    (checkbox as HTMLInputElement).checked = true;
    checkbox?.dispatchEvent(new Event("change"));

    await vi.waitFor(() =>
      expect(mocks.updateSettings).toHaveBeenCalledWith({
        acknowledgedVerificationModes: ["api"],
        disclosureVersion: 2,
      }),
    );
    await vi.waitFor(() =>
      expect(mocks.verifyAudioFile).toHaveBeenCalledWith(file, acknowledged),
    );
    expect(authorization?.hidden).toBe(true);
    expect((checkbox as HTMLInputElement).required).toBe(false);
    // Recent lists the check with its saved record.
    expect(mocks.startActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Verify an audio file",
        kind: "verify",
        pageUrl: null,
        state: "running",
      }),
      20,
    );
    const entryId = (
      mocks.startActivity.mock.calls[0]?.[0] as { id: string } | undefined
    )?.id;
    // The page holds the entry, so the worker's start-up sweep keeps it.
    expect(lockNames).toEqual([`provenance-lens.activity:${String(entryId)}`]);
    await vi.waitFor(() =>
      expect(mocks.updateActivity).toHaveBeenCalledWith(entryId, {
        state: "done",
        message: "OpenAI audio signal detected",
        recordId: record.id,
      }),
    );
  });

  it("keeps the API-only action blocked in Website mode and shows Settings", async () => {
    mocks.getSettings.mockResolvedValue({
      ...apiSettings,
      verificationMode: "website",
      acknowledgedVerificationModes: ["website"],
      disclosureVersion: 2,
    });
    await import("../../src/ui/audio.js");
    await vi.waitFor(() =>
      expect(document.getElementById("api-only-message")?.hidden).toBe(false),
    );
    expect(document.getElementById("api-authorization")?.hidden).toBe(true);
    chooseAudioFile();
    await vi.waitFor(() =>
      expect(document.getElementById("audio-status")?.textContent).toContain(
        "automatic API",
      ),
    );
    expect(mocks.updateSettings).not.toHaveBeenCalled();
    expect(mocks.verifyAudioFile).not.toHaveBeenCalled();
    // A form the page refused never ran, so Recent lists nothing.
    expect(mocks.startActivity).not.toHaveBeenCalled();
  });
  /** The id of the entry the page started for its check. */
  function startedEntryId(): string | undefined {
    return (
      mocks.startActivity.mock.calls[0]?.[0] as { id: string } | undefined
    )?.id;
  }

  it("shows the connected check as complete once its verdict is saved", async () => {
    mocks.getSettings.mockResolvedValue(apiSettings);
    mocks.getIntegrationSession.mockResolvedValue({
      accountId: "account-fixture-1",
      sessionId: "session-fixture-1",
    });
    // DigiBot's poll after "save evidence": the verdict exists, the state does not say completed yet.
    mocks.runIntegratedAudioFileAction.mockResolvedValue({
      status: {
        operationId: "323e4567-e89b-42d3-a456-426614174000",
        state: "processing",
        segment: null,
        error: null,
        envelope: { result: { evidence: result } },
      },
      mediaSha256: "a".repeat(64),
    });
    await import("../../src/ui/audio.js");
    await vi.waitFor(() => expect(mocks.getSettings).toHaveBeenCalled());
    const file = chooseAudioFile();

    await vi.waitFor(() =>
      expect(mocks.runIntegratedAudioFileAction).toHaveBeenCalledWith(
        file,
        startedEntryId(),
      ),
    );
    expect(lockNames).toEqual([
      `provenance-lens.activity:${String(startedEntryId())}`,
    ]);
    const status = document.getElementById("audio-status");
    await vi.waitFor(() =>
      expect(status?.textContent).toBe(
        "Connected audio check complete. The result was saved to DigiBot History.",
      ),
    );
    expect(status?.className).toBe("status success");
    expect(document.getElementById("audio-result")?.textContent).toContain(
      "Detected signals: SynthID.",
    );
    expect(mocks.verifyAudioFile).not.toHaveBeenCalled();
    expect(mocks.updateActivity).toHaveBeenCalledWith(expect.any(String), {
      state: "done",
      message: "OpenAI audio signal detected",
      operationId: "323e4567-e89b-42d3-a456-426614174000",
    });
  });

  it("runs one check at a time, even when the box is ticked during one", async () => {
    mocks.getSettings.mockResolvedValue(apiSettings);
    mocks.getIntegrationSession.mockResolvedValue({
      accountId: "account-fixture-1",
      sessionId: "session-fixture-1",
    });
    mocks.runIntegratedAudioFileAction.mockReturnValue(
      new Promise(() => undefined),
    );
    await import("../../src/ui/audio.js");
    await vi.waitFor(() => expect(mocks.getSettings).toHaveBeenCalled());
    chooseAudioFile();
    await vi.waitFor(() =>
      expect(mocks.runIntegratedAudioFileAction).toHaveBeenCalledTimes(1),
    );
    const checkbox = document.getElementById(
      "api-acknowledgement",
    ) as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.runIntegratedAudioFileAction).toHaveBeenCalledTimes(1);
  });

  it("clears the chosen file after an error, so the same file can be chosen again", async () => {
    mocks.getSettings.mockResolvedValue(apiSettings);
    mocks.getIntegrationSession.mockResolvedValue({
      accountId: "account-fixture-1",
      sessionId: "session-fixture-1",
    });
    mocks.runIntegratedAudioFileAction.mockRejectedValue(
      new TypeError("Failed to fetch"),
    );
    await import("../../src/ui/audio.js");
    await vi.waitFor(() => expect(mocks.getSettings).toHaveBeenCalled());
    const input = document.getElementById("audio-file") as HTMLInputElement;
    const setValue = vi.fn();
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => "",
      set: setValue,
    });
    chooseAudioFile();
    await vi.waitFor(() =>
      expect(document.getElementById("audio-status")?.className).toBe(
        "status error",
      ),
    );
    expect(setValue).toHaveBeenCalledWith("");
    expect(input.disabled).toBe(false);
  });

  it("opens the palette's Verification mode view from Settings and the API-only link", async () => {
    mocks.getSettings.mockResolvedValue(apiSettings);
    await import("../../src/ui/audio.js");
    for (const id of ["open-settings", "open-verification-mode"]) {
      mocks.sendMessage.mockClear();
      document.getElementById(id)?.click();
      expect(mocks.sendMessage).toHaveBeenCalledExactlyOnceWith({
        type: "open-palette-view",
        view: "verification-mode",
      });
    }
  });

  it("has no video URL segment, Check button or Settings page link", () => {
    const html = readFileSync(
      resolve(import.meta.dirname, "../../public/audio.html"),
      "utf8",
    );
    for (const gone of [
      "audio-source",
      "video-source-url",
      "video-start-seconds",
      "check-audio",
      'type="submit"',
      "settings.html",
    ])
      expect(html).not.toContain(gone);
  });
});
