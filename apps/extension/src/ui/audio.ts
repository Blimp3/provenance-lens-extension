import {
  AUDIO_ACTION_ID,
  DISCLOSURE_VERSION,
  NormalizedProvenanceResultSchema,
  resultLabel,
  type HistoryRecord,
  type IntegrationOperationStatus,
} from "@provenance-lens/shared";

import {
  activityTitle,
  beginActivity,
  noteActivity,
  operationUpdate,
  type ActivityId,
} from "../activity.js";
import {
  createAudioHistoryRecord,
  verifyAudioFile,
} from "../actions/verify-openai-audio.js";
import { runIntegratedAudioFileAction } from "../actions/integration-audio.js";
import {
  API_MODE_REQUIRED_MESSAGE,
  isApiVerificationAuthorized,
} from "../api-verification-policy.js";
import { getIntegrationSession } from "../integration-client.js";
import { appendHistory, getSettings, updateSettings } from "../storage.js";

const fileInput = required<HTMLInputElement>("audio-file");
const status = required<HTMLElement>("audio-status");
const result = required<HTMLElement>("audio-result");
const apiAuthorization = required<HTMLElement>("api-authorization");
const apiAcknowledgement = required<HTMLInputElement>("api-acknowledgement");
const apiOnlyMessage = required<HTMLElement>("api-only-message");

void initializeAuthorization();

// The check starts on file choice, and again once the API disclosure is
// acknowledged for the file already chosen.
fileInput.addEventListener("change", () => void check());
apiAcknowledgement.addEventListener("change", () => {
  if (apiAcknowledgement.checked && fileInput.files?.length) void check();
});
// The Settings page has no Verification mode: the palette's view does.
for (const id of ["open-settings", "open-verification-mode"])
  required<HTMLElement>(id).addEventListener("click", (event) => {
    event.preventDefault();
    void chrome.runtime.sendMessage({
      type: "open-palette-view",
      view: "verification-mode",
    });
  });

async function check(): Promise<void> {
  // One check at a time: the input is disabled while one runs.
  if (fileInput.disabled) return;
  const file = fileInput.files?.[0];
  if (!file) {
    showError("Choose an audio file first.");
    return;
  }
  fileInput.disabled = true;
  result.hidden = true;
  status.textContent = "Checking the exact audio bytes...";
  status.className = "status";
  // Recent lists a check once it runs, not a form the page refused.
  let activityId: ActivityId = null;
  // A file that waits for the API acknowledgement stays chosen.
  let keepFile = false;
  try {
    const connected = await getIntegrationSession().catch(() => null);
    if (connected) {
      activityId = await beginActivity(
        activityTitle(AUDIO_ACTION_ID),
        "verify",
        null,
        { held: true },
      );
      const outcome = await runIntegratedAudioFileAction(file, activityId);
      await noteIntegratedCheck(activityId, outcome.status);
      renderIntegratedResult(outcome.status);
      status.textContent = outcome.status.envelope?.result
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
        keepFile = true;
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
    activityId = await beginActivity(
      activityTitle(AUDIO_ACTION_ID),
      "verify",
      null,
      { held: true },
    );
    const outcome = await verifyAudioFile(file, settings);
    const record = createAudioHistoryRecord(outcome);
    await appendHistory(record, settings.historyRetention);
    await noteActivity(activityId, {
      state: outcome.errorCode ? "failed" : "done",
      message: outcome.errorCode
        ? outcome.result.summary
        : resultLabel(outcome.result, "audio"),
      recordId: record.id,
    });
    renderResult(record);
    if (outcome.errorCode) showError(outcome.result.summary);
    else {
      status.textContent =
        "Audio check complete. The result was saved to history.";
      status.className = "status success";
    }
  } catch {
    await noteActivity(activityId, {
      state: "failed",
      message: "The audio result could not be saved.",
    });
    showError("The audio result could not be saved.");
  } finally {
    fileInput.disabled = false;
    // Choosing the same file again, after a switch or an error, fires a change.
    if (!keepFile) fileInput.value = "";
  }
}

/** How a connected check ended, as Recent shows it. */
async function noteIntegratedCheck(
  activityId: ActivityId,
  operation: IntegrationOperationStatus,
): Promise<void> {
  await noteActivity(activityId, operationUpdate(operation, "audio"));
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
  scope.textContent = "Checked the exact audio file bytes.";
  const history = document.createElement("a");
  history.className = "button secondary";
  history.href = "history.html";
  history.target = "_blank";
  history.rel = "noopener";
  history.textContent = "Open DigiBot History";
  result.append(heading, summary, scope, history);
  result.hidden = false;
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
