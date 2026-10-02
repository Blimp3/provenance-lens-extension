import {
  DOWNLOAD_ACTION_ID,
  LINK_ACTION_ID,
  NormalizedProvenanceResultSchema,
  PICK_VIDEO_ACTION_ID,
  resultLabel,
  type ActionId,
  type MediaKind,
  type WorkflowState,
} from "@provenance-lens/shared";

import { ACTION_REGISTRY, type ActionDefinition } from "../actions/registry.js";
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
import {
  isLinkOutput,
  LINK_OUTPUT_LABELS,
  LINK_OUTPUTS,
  linkOptionsFor,
  type ClipField,
} from "./link-output.js";

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
/**
 * A state left behind by a dead service worker must not block the button. A
 * live connected check can stay in one state for 30 s of retrieval plus a
 * 60 s poll, so only a state older than that counts as abandoned.
 */
const STALE_WORKFLOW_MS = 120_000;

/** The page-link group: its output and clip fields follow the connection; its buttons also the workflow. */
type PageLinkControls = {
  select: HTMLSelectElement;
  start: HTMLInputElement;
  end: HTMLInputElement;
  error: HTMLElement;
};
let pageLinkControls: PageLinkControls | null = null;

for (const action of ACTION_REGISTRY) {
  if (action.inputType === "page-link") {
    actionList.append(createPageLinkGroup(action));
    continue;
  }
  // The video picker's button lives inside the page-link group.
  if (action.inputType === "video-pick") continue;
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
  const [connected, workflow] = await Promise.all([
    isIntegrationConnected().catch(() => false),
    getWorkflowState(),
  ]);
  for (const button of actionList.querySelectorAll<HTMLButtonElement>(
    "button[data-action-id]",
  )) {
    const actionId = button.dataset["actionId"];
    if (actionId === DOWNLOAD_ACTION_ID) {
      button.disabled = !connected;
      button.title = connected
        ? "Send the selected original image to your linked DigiBot account."
        : "Connect DigiBot in Settings before downloading an image.";
    } else if (actionId === LINK_ACTION_ID) {
      button.disabled = !connected || !pageLinkAvailable(workflow);
      button.title = connected
        ? "Send only this page's link to your linked DigiBot account; the video, MP3 or clip arrives in your Telegram chat."
        : "Connect DigiBot in Settings before sending a page link.";
    } else if (actionId === PICK_VIDEO_ACTION_ID) {
      button.disabled = !connected || !pageLinkAvailable(workflow);
      button.title = connected
        ? "Click a post with a video on this page; only its link is sent to your linked DigiBot account, with the output chosen above."
        : "Connect DigiBot in Settings before picking a video.";
    }
  }
  if (pageLinkControls) {
    const { select, start, end } = pageLinkControls;
    for (const control of [select, start, end]) control.disabled = !connected;
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

/**
 * A page link may be sent while nothing else runs. "picking" is harmless to
 * overwrite: an abandoned picker never reports back and a live one rewrites
 * the state itself. Any other status (a running image check, a send) keeps
 * its Cancel button until it has gone unrefreshed for two minutes, which only
 * a service worker killed mid-action leaves behind.
 */
function pageLinkAvailable(workflow: WorkflowState): boolean {
  if (
    workflow.status === "idle" ||
    workflow.status === "error" ||
    workflow.status === "picking"
  )
    return true;
  return Date.now() - Date.parse(workflow.updatedAt) > STALE_WORKFLOW_MS;
}

/**
 * The page-link entry is a group: the output to send (Video, MP3 or a Clip),
 * the clip's Start and End once Clip is chosen, an inline error, the send
 * button and the video picker's button, which sends a clicked post's link
 * with the same output. An invalid clip is reported here and nothing starts.
 */
function createPageLinkGroup(
  action: Extract<ActionDefinition, { inputType: "page-link" }>,
): HTMLElement {
  const group = document.createElement("div");
  group.className = "stack";

  const label = document.createElement("label");
  label.htmlFor = "link-output";
  label.textContent = "Send to Telegram as";
  const select = document.createElement("select");
  select.id = "link-output";
  for (const value of LINK_OUTPUTS) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = LINK_OUTPUT_LABELS[value];
    select.append(option);
  }

  const clip = document.createElement("div");
  clip.id = "link-clip-fields";
  clip.className = "stack";
  clip.hidden = true;
  const bounds = document.createElement("div");
  bounds.className = "clip-fields";
  const hint = document.createElement("p");
  hint.id = "link-clip-hint";
  hint.className = "muted small";
  hint.textContent =
    "Whole seconds as ss, m:ss or h:mm:ss, within 24 hours; the clip keeps the 1080p ceiling (or the M4A on YouTube Music).";
  const error = document.createElement("p");
  error.id = "link-output-error";
  error.className = "status error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  // A focused field reads its hint and, once shown, the error.
  const describedBy = `${hint.id} ${error.id}`;
  const start = clockInput("link-clip-start", "Start", describedBy);
  const end = clockInput("link-clip-end", "End", describedBy);
  bounds.append(start.label, end.label);
  clip.append(bounds, hint);

  const controls = { select, start: start.input, end: end.input, error };
  select.addEventListener("change", () => {
    clip.hidden = select.value !== "clip";
    clearPageLinkError(controls);
  });
  for (const input of [start.input, end.input])
    input.addEventListener("input", () => clearPageLinkError(controls));
  group.append(label, select, clip, error, pageLinkButton(action, controls));
  const pick = ACTION_REGISTRY.find(
    (entry) => entry.inputType === "video-pick",
  );
  if (pick) group.append(pageLinkButton(pick, controls, "secondary"));
  pageLinkControls = controls;
  return group;
}

function pageLinkButton(
  action: ActionDefinition,
  controls: PageLinkControls,
  className?: string,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  if (className) button.className = className;
  button.textContent = action.triggerLabel;
  button.title = action.description;
  button.dataset["actionId"] = action.id;
  button.addEventListener("click", () =>
    startPageLink(action.id, controls, button),
  );
  return button;
}

function clockInput(
  id: string,
  text: string,
  describedBy: string,
): { label: HTMLLabelElement; input: HTMLInputElement } {
  const label = document.createElement("label");
  label.htmlFor = id;
  label.append(text);
  const input = document.createElement("input");
  input.id = id;
  input.type = "text";
  input.inputMode = "numeric";
  input.placeholder = "mm:ss";
  input.autocomplete = "off";
  input.setAttribute("aria-describedby", describedBy);
  label.append(input);
  return { label, input };
}

function startPageLink(
  actionId: ActionId,
  controls: PageLinkControls,
  button: HTMLButtonElement,
): void {
  const output = controls.select.value;
  const read = linkOptionsFor(
    isLinkOutput(output) ? output : "video",
    controls.start.value,
    controls.end.value,
  );
  if (!read.ok) {
    showPageLinkError(controls, read.message, read.fields);
    return;
  }
  // One page link per click; the stored workflow state re-enables the button.
  button.disabled = true;
  void chrome.runtime
    .sendMessage({
      type: "start-action",
      actionId,
      trigger: "popup",
      ...(read.options ? { options: read.options } : {}),
    })
    .then(() => {
      // The page-link action reports back in this popup, so it stays open;
      // the video picker continues on the page, so the popup closes.
      if (actionId === PICK_VIDEO_ACTION_ID) window.close();
    })
    .catch(() => {
      button.disabled = false;
      setStatus("The selected check could not be started.", true);
    });
}

function showPageLinkError(
  controls: PageLinkControls,
  message: string,
  fields: readonly ClipField[],
): void {
  controls.error.textContent = message;
  controls.error.hidden = false;
  // Any edit since the last click already cleared the earlier marks.
  for (const field of fields)
    controls[field].setAttribute("aria-invalid", "true");
  controls[fields[0] ?? "start"].focus();
}

function clearPageLinkError(controls: PageLinkControls): void {
  controls.error.hidden = true;
  controls.error.textContent = "";
  controls.start.removeAttribute("aria-invalid");
  controls.end.removeAttribute("aria-invalid");
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
