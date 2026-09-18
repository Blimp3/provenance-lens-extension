import {
  DOWNLOAD_ACTION_ID,
  NormalizedProvenanceResultSchema,
  resultLabel,
  type MediaKind,
} from "@provenance-lens/shared";

import { ACTION_REGISTRY } from "../actions/registry.js";
import {
  getLatestRecord,
  getSettings,
  getWindowLatestRecord,
  getWorkflowState,
  STORAGE_KEYS,
} from "../storage.js";
import {
  getOptionalAccessState,
  optionalAccessStatusText,
  requestFullOptionalAccess,
} from "./optional-access.js";
import { isIntegrationConnected } from "../integration-client.js";

const actionList = required<HTMLElement>("action-list");
const workflowStatus = required<HTMLElement>("workflow-status");
const latestCard = required<HTMLElement>("latest-card");
const latestResult = required<HTMLElement>("latest-result");
const latestDetails = required<HTMLAnchorElement>("latest-details");
const cancelButton = required<HTMLButtonElement>("cancel-verification");
const optionalAccessButton = required<HTMLButtonElement>(
  "grant-optional-access",
);
const optionalAccessStatus = required<HTMLElement>("optional-access-status");
const optionalAccessCard = required<HTMLElement>("optional-access-card");
const verificationModeSummary = required<HTMLElement>(
  "verification-mode-summary",
);

for (const action of ACTION_REGISTRY) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = action.triggerLabel;
  button.title = action.description;
  button.dataset["actionId"] = action.id;
  button.addEventListener("click", () => {
    void chrome.runtime
      .sendMessage({
        type: "start-action",
        actionId: action.id,
        trigger: "popup",
      })
      .then(() => window.close())
      .catch(() => {
        setStatus("The selected check could not be started.", true);
      });
  });
  actionList.append(button);
}

cancelButton.addEventListener("click", () => {
  cancelButton.disabled = true;
  workflowStatus.textContent = "Cancelling verification...";
  void chrome.runtime.sendMessage({ type: "cancel-active" }).catch(() => {
    cancelButton.disabled = false;
    setStatus("The active verification could not be cancelled.", true);
  });
});

optionalAccessButton.addEventListener("click", () => {
  void grantOptionalAccess();
});

required<HTMLButtonElement>("open-settings").addEventListener("click", () => {
  void chrome.runtime.openOptionsPage().catch(() => {
    setStatus("The Settings page could not be opened.", true);
  });
});

void refreshPopup();
void refreshOptionalAccess();
void refreshIntegrationActions();
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" && areaName !== "session") return;
  void refreshIntegrationActions();
  if (
    changes[STORAGE_KEYS.workflow] ||
    changes[STORAGE_KEYS.settings] ||
    changes[STORAGE_KEYS.history] ||
    changes[STORAGE_KEYS.latest] ||
    changes[STORAGE_KEYS.popupLatestByWindow]
  )
    void refreshPopup();
});
chrome.permissions.onAdded.addListener(refreshOptionalAccessFromBrowser);
chrome.permissions.onRemoved.addListener(refreshOptionalAccessFromBrowser);
window.addEventListener("focus", refreshOptionalAccessFromBrowser);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible")
    refreshOptionalAccessFromBrowser();
});

function refreshOptionalAccessFromBrowser(): void {
  void refreshOptionalAccess();
}

async function refreshPopup(): Promise<void> {
  const [workflow, settings] = await Promise.all([
    getWorkflowState(),
    getSettings(),
  ]);
  verificationModeSummary.textContent =
    settings.verificationMode === "website"
      ? "Website mode: save the exact file, then review it manually on OpenAI Verify."
      : "API mode: return and cache a normalized result through your configured backend.";
  workflowStatus.textContent = workflow.message;
  workflowStatus.className =
    workflow.status === "error" ? "status error" : "status";
  const cancellable =
    workflow.status === "retrieving" || workflow.status === "verifying";
  cancelButton.hidden = !cancellable;
  cancelButton.disabled = false;

  const latest = await getPopupLatestRecord();
  if (!latest) {
    latestCard.hidden = true;
    return;
  }
  latestCard.hidden = false;
  latestDetails.href = `details.html?id=${encodeURIComponent(latest.id)}`;
  const parsed = NormalizedProvenanceResultSchema.safeParse(latest.result);
  latestDetails.className = `button ${parsed.success ? resultActionClass(parsed.data.verdict) : "secondary"}`;
  latestDetails.textContent = "Show result details";
  latestResult.replaceChildren(
    renderResultSummary(latest.result, latest.mediaKind),
  );
}

async function refreshIntegrationActions(): Promise<void> {
  const connected = await isIntegrationConnected().catch(() => false);
  for (const button of actionList.querySelectorAll<HTMLButtonElement>(
    "button[data-action-id]",
  )) {
    if (button.dataset["actionId"] !== DOWNLOAD_ACTION_ID) continue;
    button.disabled = !connected;
    button.title = connected
      ? "Send the selected original image to your linked DigiBot account."
      : "Connect DigiBot in Settings before downloading an image.";
  }
}

async function getPopupLatestRecord() {
  try {
    const currentWindow = await chrome.windows.getCurrent();
    if (currentWindow.id !== undefined) {
      const windowLatest = await getWindowLatestRecord(currentWindow.id);
      if (windowLatest) return windowLatest;
    }
  } catch {
    // Older browsers still show the global latest record.
  }
  return getLatestRecord();
}

async function grantOptionalAccess(): Promise<void> {
  optionalAccessButton.disabled = true;
  optionalAccessStatus.textContent = "Waiting for browser confirmation...";
  optionalAccessStatus.className = "status";
  try {
    const result = await requestFullOptionalAccess();
    if (result.outcome === "denied") {
      showOptionalAccessState(result.state, true);
      return;
    }
    showOptionalAccessState(result.state);
  } catch {
    optionalAccessStatus.textContent =
      "The browser could not complete the optional access request.";
    optionalAccessStatus.className = "status error";
    optionalAccessButton.disabled = false;
  }
}

async function refreshOptionalAccess(): Promise<void> {
  try {
    showOptionalAccessState(await getOptionalAccessState());
  } catch {
    optionalAccessStatus.textContent = "Optional access status is unavailable.";
    optionalAccessStatus.className = "status error";
    optionalAccessButton.disabled = false;
  }
}

function showOptionalAccessState(
  state: Awaited<ReturnType<typeof getOptionalAccessState>>,
  requestDenied = false,
): void {
  const stateText = optionalAccessStatusText(state);
  optionalAccessCard.hidden = state.complete;
  optionalAccessStatus.textContent = requestDenied
    ? `The browser did not grant the full request. ${stateText}`
    : stateText;
  optionalAccessStatus.className = state.complete
    ? "status success"
    : requestDenied
      ? "status error"
      : "status";
  optionalAccessButton.disabled = state.complete;
  optionalAccessButton.textContent = state.complete
    ? "Optional access granted"
    : "Grant optional access";
}

function renderResultSummary(
  result: unknown,
  mediaKind: MediaKind = "image",
): HTMLElement {
  const parsed = NormalizedProvenanceResultSchema.safeParse(result);
  const container = document.createElement("div");
  if (!parsed.success) {
    container.textContent = "The saved result is unavailable.";
    return container;
  }
  const heading = document.createElement("strong");
  heading.textContent = resultLabel(parsed.data, mediaKind);
  const summary = document.createElement("p");
  summary.className = "muted small";
  summary.textContent = parsed.data.summary;
  container.append(heading, summary);
  return container;
}

function resultActionClass(verdict: string): string {
  if (verdict === "openai_signal_detected") return "result-action-detected";
  if (verdict === "no_supported_openai_signal")
    return "result-action-no-signal";
  return "secondary";
}

function setStatus(text: string, error = false): void {
  workflowStatus.textContent = text;
  workflowStatus.className = error ? "status error" : "status";
}

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
}
