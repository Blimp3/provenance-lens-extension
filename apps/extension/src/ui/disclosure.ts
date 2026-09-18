import {
  ExtensionMessageSchema,
  type VerificationMode,
} from "@provenance-lens/shared";

import { getSettings } from "../storage.js";

const status = required<HTMLElement>("disclosure-status");
const websiteDisclosure = required<HTMLElement>("website-disclosure");
const apiDisclosure = required<HTMLElement>("api-disclosure");
const acknowledgeButton = required<HTMLButtonElement>("acknowledge");
const pendingId = new URLSearchParams(location.search).get("pending");
let renderedMode: VerificationMode | null = null;

acknowledgeButton.disabled = true;
void initializeDisclosure();

required<HTMLButtonElement>("cancel").addEventListener("click", () => {
  window.close();
});
acknowledgeButton.addEventListener("click", () => {
  void acknowledge();
});

async function acknowledge(): Promise<void> {
  const message =
    renderedMode === null ? null : resumePermissionMessage(renderedMode);
  if (!message) {
    showInvalidDisclosure();
    return;
  }
  acknowledgeButton.disabled = true;
  try {
    await chrome.runtime.sendMessage(message);
    status.textContent = "Disclosure acknowledged. The picker is starting.";
    status.className = "status success";
    setTimeout(() => window.close(), 300);
  } catch {
    acknowledgeButton.disabled = false;
    status.textContent = "The disclosure could not be acknowledged. Try again.";
    status.className = "status error";
  }
}

async function initializeDisclosure(): Promise<void> {
  if (!pendingId) {
    showInvalidDisclosure();
    return;
  }
  try {
    const settings = await getSettings();
    if (!resumePermissionMessage(settings.verificationMode)) {
      showInvalidDisclosure();
      return;
    }
    renderModeDisclosure(settings.verificationMode);
  } catch {
    status.textContent =
      "The verification mode could not be loaded. Close this page and try again.";
    status.className = "status error";
  }
}

function resumePermissionMessage(mode: VerificationMode) {
  const parsed = ExtensionMessageSchema.safeParse({
    type: "resume-permission",
    pendingId,
    verificationMode: mode,
  });
  return parsed.success ? parsed.data : null;
}

function showInvalidDisclosure(): void {
  status.textContent = "This disclosure link is invalid.";
  status.className = "status error";
  acknowledgeButton.disabled = true;
}

function renderModeDisclosure(mode: VerificationMode): void {
  const websiteMode = mode === "website";
  websiteDisclosure.hidden = !websiteMode;
  apiDisclosure.hidden = websiteMode;
  renderedMode = mode;
  acknowledgeButton.disabled = false;
}

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
}
