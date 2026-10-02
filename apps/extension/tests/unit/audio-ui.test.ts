import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendHistory: vi.fn(),
  createAudioHistoryRecord: vi.fn(),
  getIntegrationSession: vi.fn(),
  getSettings: vi.fn(),
  runIntegratedAudioFileAction: vi.fn(),
  runIntegratedAudioSegmentAction: vi.fn(),
  updateSettings: vi.fn(),
  verifyAudioFile: vi.fn(),
}));

vi.mock("../../src/actions/verify-openai-audio.js", () => ({
  createAudioHistoryRecord: mocks.createAudioHistoryRecord,
  verifyAudioFile: mocks.verifyAudioFile,
}));
vi.mock("../../src/actions/integration-audio.js", () => ({
  runIntegratedAudioFileAction: mocks.runIntegratedAudioFileAction,
  runIntegratedAudioSegmentAction: mocks.runIntegratedAudioSegmentAction,
}));
vi.mock("../../src/integration-client.js", () => ({
  getIntegrationSession: mocks.getIntegrationSession,
}));
vi.mock("../../src/storage.js", () => ({
  appendHistory: mocks.appendHistory,
  getSettings: mocks.getSettings,
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
      <select id="audio-source">
        <option value="file" selected>Audio file</option>
        <option value="video">Video segment</option>
      </select>
      <input id="audio-file" type="file">
      <div id="video-segment-fields" hidden>
        <input id="video-source-url" type="url">
        <input id="video-start-seconds" type="number">
        <input id="video-end-seconds" type="number">
      </div>
      <button id="check-audio" type="submit"></button>
      <p id="audio-status"></p>
      <div id="audio-result" hidden></div>
      <div id="api-authorization" hidden>
        <input id="api-acknowledgement" type="checkbox">
      </div>
      <p id="api-only-message" hidden><a href="settings.html">Settings</a></p>
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
  return selected;
}

function chooseVideoSegment(url: string, start: string, end: string): void {
  const source = document.getElementById("audio-source");
  if (!(source instanceof HTMLSelectElement))
    throw new Error("Missing audio source select");
  source.value = "video";
  source.dispatchEvent(new Event("change"));
  for (const [id, value] of [
    ["video-source-url", url],
    ["video-start-seconds", start],
    ["video-end-seconds", end],
  ] as const) {
    const input = document.getElementById(id);
    if (!(input instanceof HTMLInputElement)) throw new Error(`Missing ${id}`);
    input.value = value;
  }
}

describe("audio check authorization", () => {
  beforeEach(() => {
    vi.resetModules();
    renderPage();
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
    mocks.runIntegratedAudioSegmentAction.mockReset();
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: { runtime: { openOptionsPage: vi.fn() } },
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
    (checkbox as HTMLInputElement).checked = true;
    const file = chooseAudioFile();
    document
      .getElementById("audio-form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

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
    document
      .getElementById("audio-form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() =>
      expect(document.getElementById("audio-status")?.textContent).toContain(
        "automatic API",
      ),
    );
    expect(mocks.updateSettings).not.toHaveBeenCalled();
    expect(mocks.verifyAudioFile).not.toHaveBeenCalled();
  });
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
    document
      .getElementById("audio-form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() =>
      expect(mocks.runIntegratedAudioFileAction).toHaveBeenCalledWith(file),
    );
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
  });

  it("shows the segment check as complete once its verdict is saved", async () => {
    mocks.getSettings.mockResolvedValue(apiSettings);
    mocks.getIntegrationSession.mockResolvedValue({
      accountId: "account-fixture-1",
      sessionId: "session-fixture-1",
    });
    mocks.runIntegratedAudioSegmentAction.mockResolvedValue({
      status: {
        operationId: "423e4567-e89b-42d3-a456-426614174000",
        state: "processing",
        segment: { startSeconds: 5, endSeconds: 20 },
        error: null,
        envelope: { result: { evidence: result } },
      },
      mediaSha256: null,
    });
    await import("../../src/ui/audio.js");
    await vi.waitFor(() => expect(mocks.getSettings).toHaveBeenCalled());
    chooseVideoSegment("https://video.example/watch?v=fixture", "5", "20");
    document
      .getElementById("audio-form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() =>
      expect(mocks.runIntegratedAudioSegmentAction).toHaveBeenCalledWith(
        "https://video.example/watch?v=fixture",
        5,
        20,
      ),
    );
    const status = document.getElementById("audio-status");
    await vi.waitFor(() =>
      expect(status?.textContent).toBe(
        "Audio segment check complete. The result was saved to DigiBot History.",
      ),
    );
    expect(status?.className).toBe("status success");
    expect(document.getElementById("audio-result")?.textContent).toContain(
      "Checked audio segment: 5–20 seconds.",
    );
    expect(mocks.runIntegratedAudioFileAction).not.toHaveBeenCalled();
    expect(mocks.verifyAudioFile).not.toHaveBeenCalled();
  });
});
