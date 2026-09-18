import {
  DEFAULT_BACKEND_URL,
  ExtensionSettingsSchema,
  HistoryRetentionSchema,
  VerificationModeSchema,
  originPattern,
  parseBackendBaseUrl,
  sanitizeDisplayText,
  type ExtensionSettings,
  type VerificationMode,
} from "@provenance-lens/shared";

import { clearVerificationCache, setCacheLimit } from "../cache.js";
import { getBundledClientTokenForBackend } from "../bundled-client.js";
import {
  clearHistory,
  defaultSettings,
  getSettings,
  saveSettings,
} from "../storage.js";
import {
  getOptionalAccessState,
  optionalAccessStatusText,
  requestFullOptionalAccess,
} from "./optional-access.js";
import {
  createPairing,
  disconnectIntegration,
  exchangePairing,
  getIntegrationSession,
  getPendingPairing,
} from "../integration-client.js";

const form = required<HTMLFormElement>("settings-form");
const verificationMode = required<HTMLSelectElement>("verification-mode");
const websiteModeDisclosure = required<HTMLElement>("website-mode-disclosure");
const apiModeDisclosure = required<HTMLElement>("api-mode-disclosure");
const backendUrl = required<HTMLInputElement>("backend-url");
const clientToken = required<HTMLInputElement>("client-token");
const retention = required<HTMLSelectElement>("history-retention");
const localCacheLimit = required<HTMLSelectElement>("local-cache-limit");
const includePageTitle = required<HTMLInputElement>("include-page-title");
const debugMode = required<HTMLInputElement>("debug-mode");
const screenshotFallback = required<HTMLInputElement>("screenshot-fallback");
const connectionStatus = required<HTMLElement>("connection-status");
const historyStatus = required<HTMLElement>("history-status");
const cacheStatus = required<HTMLElement>("cache-status");
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
const integrationStatus = document.getElementById("integration-status");
const integrationPairing = document.getElementById("integration-pairing");
const integrationCommand = document.getElementById("integration-command");
const integrationCode = document.getElementById("integration-code");
const startPairingButton = document.getElementById(
  "start-pairing",
) as HTMLButtonElement | null;
const completePairingButton = document.getElementById(
  "complete-pairing",
) as HTMLButtonElement | null;
const disconnectIntegrationButton = document.getElementById(
  "disconnect-integration",
) as HTMLButtonElement | null;

void loadSettings();
void refreshIntegrationUI();
verificationMode.addEventListener("change", () => {
  const parsed = VerificationModeSchema.safeParse(verificationMode.value);
  if (parsed.success) setVerificationModeDisclosure(parsed.data);
});
required<HTMLButtonElement>("test-connection").addEventListener("click", () => {
  void testConnection();
});
requestBackendPermissionButton.addEventListener("click", () => {
  void requestBackendAccess();
});
required<HTMLButtonElement>("clear-history").addEventListener("click", () => {
  void clearSavedHistory();
});
required<HTMLButtonElement>("clear-cache").addEventListener("click", () => {
  void clearSavedCache();
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
startPairingButton?.addEventListener("click", () => {
  void startIntegrationPairing();
});
completePairingButton?.addEventListener("click", () => {
  void completeIntegrationPairing();
});
disconnectIntegrationButton?.addEventListener("click", () => {
  void disconnectLinkedIntegration();
});
required<HTMLButtonElement>("refresh-permissions").addEventListener(
  "click",
  () => {
    void refreshPermissionDisplays();
  },
);
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
  verificationMode.value = settings.verificationMode;
  setVerificationModeDisclosure(settings.verificationMode);
  backendUrl.value = settings.backendBaseUrl || DEFAULT_BACKEND_URL;
  const bundledToken = getBundledClientTokenForBackend(settings.backendBaseUrl);
  clientToken.value = settings.clientToken;
  retention.value = String(settings.historyRetention);
  localCacheLimit.value = String(settings.localCacheLimit);
  includePageTitle.checked = settings.includePageTitle;
  debugMode.checked = settings.debugMode;
  screenshotFallback.checked = settings.screenshotFallbackEnabled;
  refreshBackendConnectionUI();
  await refreshPermissionDisplays();
  if (bundledToken) await testConnection(bundledToken, true);
}

async function saveFormSettings(): Promise<void> {
  const parsedMode = VerificationModeSchema.safeParse(verificationMode.value);
  if (!parsedMode.success) {
    setStatus(connectionStatus, "Choose a valid verification mode.", true);
    return;
  }
  const mode = parsedMode.data;
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
  const parsedRetention = HistoryRetentionSchema.safeParse(
    Number(retention.value),
  );
  if (!parsedRetention.success) {
    setStatus(
      connectionStatus,
      "Choose a valid history retention setting.",
      true,
    );
    return;
  }
  const parsedCacheLimit = Number(localCacheLimit.value);
  if (
    !Number.isInteger(parsedCacheLimit) ||
    parsedCacheLimit < 10 ||
    parsedCacheLimit > 1_000
  ) {
    setStatus(connectionStatus, "Choose a valid local cache limit.", true);
    return;
  }
  const previous = await getSettings();
  const settings: ExtensionSettings = ExtensionSettingsSchema.parse({
    ...defaultSettings,
    verificationMode: mode,
    acknowledgedVerificationModes: previous.acknowledgedVerificationModes,
    backendBaseUrl: parsedUrl.toString().replace(/\/$/u, ""),
    clientToken: clientToken.value,
    historyRetention: parsedRetention.data,
    localCacheLimit: parsedCacheLimit,
    screenshotFallbackEnabled: screenshotFallback.checked,
    includePageTitle: includePageTitle.checked,
    debugMode: debugMode.checked,
    disclosureVersion: previous.disclosureVersion,
  });
  await saveSettings(settings);
  await setCacheLimit(settings.localCacheLimit);
  setStatus(connectionStatus, "Settings saved.", false);
}

function setVerificationModeDisclosure(mode: VerificationMode): void {
  const websiteMode = mode === "website";
  websiteModeDisclosure.hidden = !websiteMode;
  apiModeDisclosure.hidden = websiteMode;
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

async function clearSavedHistory(): Promise<void> {
  await clearHistory();
  const connected = await getIntegrationSession().catch(() => null);
  setStatus(
    historyStatus,
    connected
      ? "Local standalone history cleared. Manage connected History from the History page."
      : "History cleared.",
    false,
  );
}

async function clearSavedCache(): Promise<void> {
  await clearVerificationCache();
  setStatus(cacheStatus, "Local verification cache cleared.", false);
}

async function refreshIntegrationUI(): Promise<void> {
  if (
    !integrationStatus ||
    !integrationPairing ||
    !integrationCommand ||
    !integrationCode ||
    !startPairingButton ||
    !completePairingButton ||
    !disconnectIntegrationButton
  )
    return;
  try {
    const [session, pending] = await Promise.all([
      getIntegrationSession(),
      getPendingPairing(),
    ]);
    if (session) {
      integrationStatus.textContent =
        "DigiBot is connected for this browser. Connected checks and downloads use that account.";
      integrationStatus.className = "status success";
      integrationPairing.hidden = true;
      startPairingButton.hidden = true;
      completePairingButton.hidden = true;
      disconnectIntegrationButton.hidden = false;
      return;
    }
    disconnectIntegrationButton.hidden = true;
    startPairingButton.hidden = false;
    if (pending) {
      integrationStatus.textContent =
        "Pairing request ready. Approve the matching code in your private DigiBot chat.";
      integrationStatus.className = "status";
      integrationPairing.hidden = false;
      integrationCommand.textContent = `/link ${pending.pairId}`;
      integrationCode.textContent = pending.confirmationCode;
      completePairingButton.hidden = false;
      return;
    }
    integrationStatus.textContent = "DigiBot is not connected.";
    integrationStatus.className = "status";
    integrationPairing.hidden = true;
    completePairingButton.hidden = true;
  } catch {
    integrationStatus.textContent = "DigiBot connection status is unavailable.";
    integrationStatus.className = "status error";
  }
}

async function startIntegrationPairing(): Promise<void> {
  if (!integrationStatus || !startPairingButton) return;
  startPairingButton.disabled = true;
  integrationStatus.textContent = "Creating a short-lived pairing request...";
  integrationStatus.className = "status";
  try {
    await createPairing();
    await refreshIntegrationUI();
  } catch {
    integrationStatus.textContent =
      "The DigiBot pairing request could not be created.";
    integrationStatus.className = "status error";
  } finally {
    startPairingButton.disabled = false;
  }
}

async function completeIntegrationPairing(): Promise<void> {
  if (!integrationStatus || !completePairingButton) return;
  completePairingButton.disabled = true;
  integrationStatus.textContent = "Completing the DigiBot pairing...";
  integrationStatus.className = "status";
  try {
    await exchangePairing();
    await refreshIntegrationUI();
  } catch {
    integrationStatus.textContent =
      "The pairing was not approved yet or has expired. Start again after approving it in DigiBot.";
    integrationStatus.className = "status error";
  } finally {
    completePairingButton.disabled = false;
  }
}

async function disconnectLinkedIntegration(): Promise<void> {
  if (!integrationStatus || !disconnectIntegrationButton) return;
  disconnectIntegrationButton.disabled = true;
  integrationStatus.textContent = "Disconnecting DigiBot...";
  integrationStatus.className = "status";
  try {
    await disconnectIntegration();
    await refreshIntegrationUI();
  } catch {
    integrationStatus.textContent =
      "The DigiBot connection could not be cleared.";
    integrationStatus.className = "status error";
  } finally {
    disconnectIntegrationButton.disabled = false;
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
