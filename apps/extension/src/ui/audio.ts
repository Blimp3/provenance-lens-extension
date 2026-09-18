import {
  DISCLOSURE_VERSION,
  NormalizedProvenanceResultSchema,
  type HistoryRecord,
} from "@provenance-lens/shared";

import {
  createAudioHistoryRecord,
  verifyAudioFile,
} from "../actions/verify-openai-audio.js";
import {
  runIntegratedAudioFileAction,
  runIntegratedAudioSegmentAction,
} from "../actions/integration-audio.js";
import {
  API_MODE_REQUIRED_MESSAGE,
  isApiVerificationAuthorized,
} from "../api-verification-policy.js";
import { getIntegrationSession } from "../integration-client.js";
import { appendHistory, getSettings, updateSettings } from "../storage.js";

const form = required<HTMLFormElement>("audio-form");
const fileInput = required<HTMLInputElement>("audio-file");
const sourceMode = optional<HTMLSelectElement>("audio-source");
const videoFields = optional<HTMLElement>("video-segment-fields");
const videoSource = optional<HTMLInputElement>("video-source-url");
const videoStart = optional<HTMLInputElement>("video-start-seconds");
const videoEnd = optional<HTMLInputElement>("video-end-seconds");
const button = required<HTMLButtonElement>("check-audio");
const status = required<HTMLElement>("audio-status");
const result = required<HTMLElement>("audio-result");
const apiAuthorization = required<HTMLElement>("api-authorization");
const apiAcknowledgement = required<HTMLInputElement>("api-acknowledgement");
const apiOnlyMessage = required<HTMLElement>("api-only-message");

sourceMode?.addEventListener("change", refreshSourceMode);
const sourceFromTab = new URLSearchParams(location.search).get("source");
if (sourceFromTab && videoSource && sourceMode) {
  videoSource.value = sourceFromTab;
  sourceMode.value = "video";
}
refreshSourceMode();
void initializeAuthorization();

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void check();
});
required<HTMLButtonElement>("open-settings").addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

async function check(): Promise<void> {
  if (sourceMode?.value === "video") {
    await checkVideoSegment();
    return;
  }
  const file = fileInput.files?.[0];
  if (!file) {
    showError("Choose an audio file first.");
    return;
  }
  button.disabled = true;
  result.hidden = true;
  status.textContent = "Checking the exact audio bytes...";
  status.className = "status";
  try {
    const connected = await getIntegrationSession().catch(() => null);
    if (connected) {
      const outcome = await runIntegratedAudioFileAction(file);
      renderIntegratedResult(outcome.status);
      status.textContent =
        outcome.status.state === "completed"
          ? "Connected audio check complete. The result was saved to DigiBot History."
          : "Connected audio check is still processing. DigiBot History will update.";
      status.className =
        outcome.status.state === "failed" ? "status error" : "status success";
      return;
    }
    let settings = await getSettings();
    if (settings.verificationMode !== "api") {
      renderAuthorization(settings);
      showError(API_MODE_REQUIRED_MESSAGE);
      return;
    }
    if (!isApiVerificationAuthorized(settings)) {
      if (!apiAcknowledgement.checked) {
        renderAuthorization(settings);
        showError(
          "Acknowledge the API privacy disclosure before checking this audio file.",
        );
        return;
      }
      settings = await updateSettings({
        acknowledgedVerificationModes: Array.from(
          new Set([...settings.acknowledgedVerificationModes, "api"]),
        ),
        disclosureVersion: DISCLOSURE_VERSION,
      });
      renderAuthorization(settings);
    }
    const outcome = await verifyAudioFile(file, settings);
    const record = createAudioHistoryRecord(outcome);
    await appendHistory(record, settings.historyRetention);
    renderResult(record);
    if (outcome.errorCode) showError(outcome.result.summary);
    else {
      status.textContent =
        "Audio check complete. The result was saved to history.";
      status.className = "status success";
    }
  } catch {
    showError("The audio result could not be saved.");
  } finally {
    button.disabled = false;
  }
}

async function checkVideoSegment(): Promise<void> {
  const source = videoSource?.value.trim() ?? "";
  const start = Number(videoStart?.value ?? "");
  const end = Number(videoEnd?.value ?? "");
  if (!source || !Number.isFinite(start) || !Number.isFinite(end)) {
    showError("Enter a video URL and whole-second start and end times.");
    return;
  }
  button.disabled = true;
  result.hidden = true;
  status.textContent = "Requesting the selected audio segment...";
  status.className = "status";
  try {
    if (!(await getIntegrationSession().catch(() => null))) {
      showError(
        "Connect Provenance Lens to DigiBot before checking a video segment.",
      );
      return;
    }
    const outcome = await runIntegratedAudioSegmentAction(source, start, end);
    renderIntegratedResult(outcome.status);
    status.textContent =
      outcome.status.state === "completed"
        ? "Audio segment check complete. The result was saved to DigiBot History."
        : "Audio segment check is still processing. DigiBot History will update.";
    status.className =
      outcome.status.state === "failed" ? "status error" : "status success";
  } catch (error: unknown) {
    showError(
      error instanceof Error
        ? error.message
        : "The audio segment could not be checked.",
    );
  } finally {
    button.disabled = false;
  }
}

async function initializeAuthorization(): Promise<void> {
  try {
    renderAuthorization(await getSettings());
  } catch {
    // The submit path reads settings again and reports a save/verification error.
  }
}

function renderAuthorization(settings: {
  verificationMode: "api" | "website";
  acknowledgedVerificationModes: readonly ("api" | "website")[];
  disclosureVersion: number;
}): void {
  const apiMode = settings.verificationMode === "api";
  if (sourceMode?.value === "video") {
    apiAuthorization.hidden = true;
    apiAcknowledgement.required = false;
    apiOnlyMessage.hidden = true;
    return;
  }
  const needsAcknowledgement =
    apiMode && !isApiVerificationAuthorized(settings);
  apiAuthorization.hidden = !needsAcknowledgement;
  apiAcknowledgement.required = needsAcknowledgement;
  apiOnlyMessage.hidden = apiMode;
}

function renderIntegratedResult(
  operation: Awaited<ReturnType<typeof runIntegratedAudioFileAction>>["status"],
): void {
  result.replaceChildren();
  const evidence = operation.envelope?.result?.evidence;
  const heading = document.createElement("strong");
  heading.textContent = evidence
    ? verdictLabel(evidence.verdict)
    : operation.state === "failed"
      ? "Audio check failed"
      : `Audio check ${operation.state}`;
  const summary = document.createElement("p");
  summary.className = "muted small";
  summary.textContent =
    operation.error?.message ??
    evidence?.summary ??
    `Operation ${operation.operationId} is ${operation.state}.`;
  const scope = document.createElement("p");
  scope.className = "muted small";
  scope.textContent = operation.segment
    ? `Checked audio segment: ${operation.segment.startSeconds}–${operation.segment.endSeconds} seconds.`
    : "Checked the exact audio file bytes.";
  const history = document.createElement("a");
  history.className = "button secondary";
  history.href = "history.html";
  history.target = "_blank";
  history.rel = "noopener";
  history.textContent = "Open DigiBot History";
  result.append(heading, summary, scope, history);
  result.hidden = false;
}

function refreshSourceMode(): void {
  if (!sourceMode) return;
  const video = sourceMode?.value === "video";
  videoFields?.toggleAttribute("hidden", !video);
  fileInput.required = !video;
  if (video)
    renderAuthorization({
      verificationMode: "api",
      acknowledgedVerificationModes: [],
      disclosureVersion: 0,
    });
  else
    void getSettings()
      .then((settings) => {
        if (settings) renderAuthorization(settings);
      })
      .catch(() => undefined);
}

function renderResult(record: HistoryRecord): void {
  const parsed = NormalizedProvenanceResultSchema.safeParse(record.result);
  result.replaceChildren();
  const heading = document.createElement("strong");
  heading.textContent = parsed.success
    ? verdictLabel(parsed.data.verdict)
    : "Audio result unavailable";
  const summary = document.createElement("p");
  summary.className = "muted small";
  summary.textContent = parsed.success
    ? parsed.data.summary
    : "The saved result is unavailable.";
  const details = document.createElement("a");
  details.className = "button secondary";
  details.href = `details.html?id=${encodeURIComponent(record.id)}`;
  details.target = "_blank";
  details.rel = "noopener";
  details.textContent = "Show result details";
  result.append(heading, summary, details);
  result.hidden = false;
}

function verdictLabel(verdict: string): string {
  if (verdict === "openai_signal_detected")
    return "OpenAI audio signal detected";
  if (verdict === "no_supported_openai_signal")
    return "No supported OpenAI audio signal detected";
  return "The audio could not be verified";
}

function showError(message: string): void {
  status.textContent = message;
  status.className = "status error";
}

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
}

function optional<T extends HTMLElement>(id: string): T | null {
  const element = document.getElementById(id);
  return element ? (element as T) : null;
}
