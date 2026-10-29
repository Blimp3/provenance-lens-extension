import {
  DEFAULT_BACKEND_URL,
  originPattern,
  parseBackendBaseUrl,
  sanitizeDisplayText,
} from "@provenance-lens/shared";

import { getBundledClientTokenForBackend } from "../bundled-client.js";
import { getSettings, updateSettings } from "../storage.js";
import {
  getOptionalAccessState,
  optionalAccessStatusText,
  requestFullOptionalAccess,
} from "./optional-access.js";

const form = required<HTMLFormElement>("settings-form");
const backendUrl = required<HTMLInputElement>("backend-url");
const clientToken = required<HTMLInputElement>("client-token");
const connectionStatus = required<HTMLElement>("connection-status");
const permissionOrigin = required<HTMLInputElement>("permission-origin");
const permissionStatus = required<HTMLElement>("permission-status");
const optionalAccessButton = required<HTMLButtonElement>(
  "grant-optional-access",
);
const optionalAccessStatus = required<HTMLElement>("optional-access-status");
const bundledClientDisclosure = required<HTMLElement>(
  "bundled-client-disclosure",
);
const backendPermissionNote = required<HTMLElement>("backend-permission-note");
const requestBackendPermissionButton = required<HTMLButtonElement>(
  "request-backend-permission",
);

void loadSettings();
required<HTMLButtonElement>("test-connection").addEventListener("click", () => {
  void testConnection();
});
requestBackendPermissionButton.addEventListener("click", () => {
  void requestBackendAccess();
});
required<HTMLButtonElement>("request-permission").addEventListener(
  "click",
  () => {
    void requestHostAccess();
  },
);
optionalAccessButton.addEventListener("click", () => {
  void grantOptionalAccess();
});
backendUrl.addEventListener("input", refreshBackendConnectionUI);
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveFormSettings();
});
chrome.permissions.onAdded.addListener(refreshPermissionsFromBrowser);
chrome.permissions.onRemoved.addListener(refreshPermissionsFromBrowser);
window.addEventListener("focus", refreshPermissionsFromBrowser);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshPermissionsFromBrowser();
});

function refreshPermissionsFromBrowser(): void {
  void refreshPermissionDisplays();
}

async function loadSettings(): Promise<void> {
  const settings = await getSettings();
  backendUrl.value = settings.backendBaseUrl || DEFAULT_BACKEND_URL;
  const bundledToken = getBundledClientTokenForBackend(settings.backendBaseUrl);
  clientToken.value = settings.clientToken;
  refreshBackendConnectionUI();
  await refreshPermissionDisplays();
  if (bundledToken) await testConnection(bundledToken, true);
}

/** Saves only the API connection; the palette owns every other setting. */
async function saveFormSettings(): Promise<void> {
  let parsedUrl: URL;
  try {
    parsedUrl = parseBackendBaseUrl(
      backendUrl.value.trim() || DEFAULT_BACKEND_URL,
    );
  } catch (error: unknown) {
    setStatus(
      connectionStatus,
      error instanceof Error ? error.message : "Enter a valid backend URL.",
      true,
    );
    return;
  }
  await updateSettings({
    backendBaseUrl: parsedUrl.toString().replace(/\/$/u, ""),
    clientToken: clientToken.value,
  });
  setStatus(connectionStatus, "Settings saved.", false);
}

async function testConnection(
  tokenOverride?: string,
  bundled = false,
): Promise<void> {
  const bundledToken = getBundledClientTokenForBackend(
    backendUrl.value.trim() || DEFAULT_BACKEND_URL,
  );
  const token = (tokenOverride ?? bundledToken) || clientToken.value.trim();
  const usesBundledToken = bundled || (!tokenOverride && Boolean(bundledToken));
  if (!token) {
    setStatus(
      connectionStatus,
      "Enter the client token before testing the connection.",
      true,
    );
    return;
  }
  let base: URL;
  try {
    base = parseBackendBaseUrl(backendUrl.value.trim());
  } catch (error: unknown) {
    setStatus(
      connectionStatus,
      error instanceof Error ? error.message : "Enter a valid backend URL.",
      true,
    );
    return;
  }
  const endpoint = new URL(base.toString());
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/u, "")}/api/health`;
  try {
    const requestInit: RequestInit = {
      credentials: "omit",
      headers: { Authorization: `Bearer ${token}` },
    };
    const response = await fetch(endpoint, requestInit);
    setStatus(
      connectionStatus,
      response.ok
        ? usesBundledToken
          ? "The bundled production connection is ready."
          : "The verification server is reachable."
        : `The server responded with HTTP ${response.status}.`,
      !response.ok,
    );
  } catch {
    setStatus(
      connectionStatus,
      "The verification server could not be reached.",
      true,
    );
  }
}

function refreshBackendConnectionUI(): void {
  const backendBaseUrl = backendUrl.value.trim() || DEFAULT_BACKEND_URL;
  const usesBundledToken = Boolean(
    getBundledClientTokenForBackend(backendBaseUrl),
  );
  bundledClientDisclosure.hidden = !usesBundledToken;
  backendPermissionNote.hidden = usesBundledToken;
  requestBackendPermissionButton.hidden = usesBundledToken;
  clientToken.disabled = usesBundledToken;
  if (usesBundledToken) clientToken.value = "";
}

async function requestBackendAccess(): Promise<void> {
  let url: URL;
  try {
    url = parseBackendBaseUrl(backendUrl.value.trim());
  } catch (error: unknown) {
    setStatus(
      connectionStatus,
      error instanceof Error ? error.message : "Enter a valid backend URL.",
      true,
    );
    return;
  }
  try {
    const granted = await chrome.permissions.request({
      origins: [originPattern(url)],
    });
    setStatus(
      connectionStatus,
      granted
        ? `Backend access granted for ${url.origin}.`
        : "Backend access was not granted.",
      !granted,
    );
  } catch {
    setStatus(
      connectionStatus,
      "The browser denied the backend permission request.",
      true,
    );
  }
}

async function requestHostAccess(): Promise<void> {
  let url: URL;
  try {
    url = new URL(permissionOrigin.value.trim());
  } catch {
    setStatus(permissionStatus, "Enter a valid HTTP or HTTPS origin.", true);
    return;
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hostname.includes("*") ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    setStatus(
      permissionStatus,
      "Enter one exact credential-free HTTP(S) origin without a wildcard or path.",
      true,
    );
    return;
  }
  const pattern = originPattern(url);
  try {
    const granted = await chrome.permissions.request({ origins: [pattern] });
    setStatus(
      permissionStatus,
      granted
        ? `Access granted for ${url.origin}.`
        : "Host access was not granted.",
      !granted,
    );
  } catch {
    setStatus(
      permissionStatus,
      "The browser denied the permission request.",
      true,
    );
  }
  await refreshPermissions();
}

async function refreshPermissions(): Promise<void> {
  try {
    const permissions = await chrome.permissions.getAll();
    const origins = (permissions.origins ?? []).filter((origin) =>
      /^https?:\/\//iu.test(origin),
    );
    setStatus(
      permissionStatus,
      origins.length
        ? `Granted hosts: ${origins.join(", ")}`
        : "No optional image-host access granted.",
      false,
    );
  } catch {
    setStatus(permissionStatus, "Permission status is unavailable.", true);
  }
}

async function refreshPermissionDisplays(): Promise<void> {
  await Promise.all([refreshPermissions(), refreshOptionalAccess()]);
}

async function grantOptionalAccess(): Promise<void> {
  optionalAccessButton.disabled = true;
  setStatus(optionalAccessStatus, "Waiting for browser confirmation...", false);
  try {
    const result = await requestFullOptionalAccess();
    if (result.outcome === "denied") {
      showOptionalAccessState(result.state, true);
      await refreshPermissions();
      return;
    }
    showOptionalAccessState(result.state);
    await refreshPermissions();
  } catch {
    setStatus(
      optionalAccessStatus,
      "The browser could not complete the optional access request.",
      true,
    );
    optionalAccessButton.disabled = false;
  }
}

async function refreshOptionalAccess(): Promise<void> {
  try {
    showOptionalAccessState(await getOptionalAccessState());
  } catch {
    setStatus(
      optionalAccessStatus,
      "Optional access status is unavailable.",
      true,
    );
    optionalAccessButton.disabled = false;
  }
}

function showOptionalAccessState(
  state: Awaited<ReturnType<typeof getOptionalAccessState>>,
  requestDenied = false,
): void {
  const stateText = optionalAccessStatusText(state);
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

function setStatus(element: HTMLElement, text: string, error: boolean): void {
  element.textContent = sanitizeDisplayText(text, 512);
  element.className = error ? "status error" : "status success";
}

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
}
