import {
  ExtensionMessageSchema,
  type DisclosureMode,
} from "@provenance-lens/shared";

import { getSettings } from "../storage.js";

const status = required<HTMLElement>("disclosure-status");
const websiteDisclosure = required<HTMLElement>("website-disclosure");
const apiDisclosure = required<HTMLElement>("api-disclosure");
const synthIdDisclosure = required<HTMLElement>("synthid-disclosure");
// The note on Lens's own checks; the SynthID handoff checks nothing.
const checksNote = required<HTMLElement>("checks-note");
const acknowledgeButton = required<HTMLButtonElement>("acknowledge");
const query = new URLSearchParams(location.search);
const pendingId = query.get("pending");
// The Google SynthID handoff has its own one-time disclosure.
const synthIdHandoff = query.get("kind") === "synthid";
let renderedMode: DisclosureMode | null = null;

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
  if (synthIdHandoff) {
    if (!resumePermissionMessage("synthid")) {
      showInvalidDisclosure();
      return;
    }
    renderModeDisclosure("synthid");
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

function resumePermissionMessage(mode: DisclosureMode) {
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

function renderModeDisclosure(mode: DisclosureMode): void {
  websiteDisclosure.hidden = mode !== "website";
  apiDisclosure.hidden = mode !== "api";
  synthIdDisclosure.hidden = mode !== "synthid";
  checksNote.hidden = mode === "synthid";
  if (mode === "synthid") {
    document.title = "Before you check with Google SynthID";
    const heading = document.getElementById("page-title");
    if (heading) heading.textContent = document.title;
  }
  renderedMode = mode;
  acknowledgeButton.disabled = false;
}

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
}
