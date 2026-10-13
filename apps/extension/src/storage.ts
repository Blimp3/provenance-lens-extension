import {
  DEFAULT_BACKEND_URL,
  DEFAULT_LOCAL_CACHE_LIMIT,
  ExtensionSettingsSchema,
  HistoryRecordSchema,
  WorkflowStateSchema,
  type ExtensionSettings,
  type HistoryRecord,
  type HistoryRetention,
  type WorkflowState,
} from "@provenance-lens/shared";

import {
  applyBundledClientToken,
  getBundledClientTokenForBackend,
} from "./bundled-client.js";

export const STORAGE_KEYS = {
  settings: "provenanceLens.settings",
  history: "provenanceLens.history",
  workflow: "provenanceLens.workflow",
  latest: "provenanceLens.latest",
  // The acknowledged SynthID disclosure version, apart from the settings.
  synthidDisclosure: "provenanceLens.synthidDisclosure",
} as const;

const STORAGE_MUTATION_LOCK = "provenance-lens.storage-mutations";
const SETTINGS_FORMAT_KEY = "provenanceLens.settingsFormat";
const SETTINGS_FORMAT_VERSION = 1;
const LEGACY_BACKEND_URL = "http://127.0.0.1:8787";

const defaultClientToken = getBundledClientTokenForBackend(DEFAULT_BACKEND_URL);

export const defaultSettings: ExtensionSettings = {
  verificationMode: defaultClientToken ? "api" : "website",
  acknowledgedVerificationModes: [],
  backendBaseUrl: DEFAULT_BACKEND_URL,
  clientToken: defaultClientToken,
  historyRetention: 20,
  screenshotFallbackEnabled: false,
  includePageTitle: true,
  debugMode: false,
  localCacheLimit: DEFAULT_LOCAL_CACHE_LIMIT,
  disclosureVersion: 0,
};

export async function getSettings(): Promise<ExtensionSettings> {
  const values = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const parsed = ExtensionSettingsSchema.safeParse(
    values[STORAGE_KEYS.settings],
  );
  if (!parsed.success) return { ...defaultSettings };

  const format = await chrome.storage.local.get(SETTINGS_FORMAT_KEY);
  const legacy = format[SETTINGS_FORMAT_KEY] === undefined;
  const backendBaseUrl =
    legacy &&
    parsed.data.backendBaseUrl === LEGACY_BACKEND_URL &&
    !parsed.data.clientToken
      ? DEFAULT_BACKEND_URL
      : parsed.data.backendBaseUrl;
  const migrated = applyBundledClientToken({
    ...parsed.data,
    backendBaseUrl,
  });
  if (
    !legacy &&
    migrated.backendBaseUrl === parsed.data.backendBaseUrl &&
    migrated.clientToken === parsed.data.clientToken
  ) {
    return parsed.data;
  }

  await chrome.storage.local.set({
    [STORAGE_KEYS.settings]: migrated,
    [SETTINGS_FORMAT_KEY]: SETTINGS_FORMAT_VERSION,
  });
  return migrated;
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  const parsed = ExtensionSettingsSchema.parse(settings);
  await chrome.storage.local.set({
    [STORAGE_KEYS.settings]: applyBundledClientToken(parsed),
    [SETTINGS_FORMAT_KEY]: SETTINGS_FORMAT_VERSION,
  });
}

export async function updateSettings(
  update: Partial<ExtensionSettings>,
): Promise<ExtensionSettings> {
  const settings = await getSettings();
  const next = ExtensionSettingsSchema.parse({ ...settings, ...update });
  await saveSettings(next);
  return next;
}

/** The SynthID disclosure version the user acknowledged; null before that. */
export async function getSynthIdDisclosureVersion(): Promise<number | null> {
  const values = await chrome.storage.local.get(STORAGE_KEYS.synthidDisclosure);
  const version = values[STORAGE_KEYS.synthidDisclosure];
  return typeof version === "number" && Number.isSafeInteger(version)
    ? version
    : null;
}

export async function setSynthIdDisclosureVersion(
  version: number,
): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEYS.synthidDisclosure]: version,
  });
}

export async function getHistory(): Promise<HistoryRecord[]> {
  const values = await chrome.storage.local.get(STORAGE_KEYS.history);
  const raw = values[STORAGE_KEYS.history];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item: unknown) => {
    const parsed = HistoryRecordSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

export async function appendHistory(
  record: HistoryRecord,
  retention: HistoryRetention,
): Promise<void> {
  const parsed = HistoryRecordSchema.parse(record);
  await withStorageMutationLock(async () => {
    await setLatestRecordUnlocked(parsed);
    if (retention === 0) return;
    const existing = await getHistory();
    const next = [parsed, ...existing].slice(0, retention);
    await writeHistoryUnlocked(next);
  });
}

export async function clearHistory(): Promise<void> {
  await withStorageMutationLock(() =>
    Promise.all([
      chrome.storage.local.remove(STORAGE_KEYS.history),
      chrome.storage.session.remove(STORAGE_KEYS.latest),
    ]).then(() => undefined),
  );
}

export async function getLatestRecord(): Promise<HistoryRecord | null> {
  const values = await chrome.storage.session.get(STORAGE_KEYS.latest);
  const parsed = HistoryRecordSchema.safeParse(values[STORAGE_KEYS.latest]);
  return parsed.success ? parsed.data : null;
}

export async function replaceHistoryRecord(
  replacement: HistoryRecord,
): Promise<boolean> {
  const parsedReplacement = HistoryRecordSchema.parse(replacement);
  const id = parsedReplacement.id;
  return withStorageMutationLock(async () => {
    const existingHistory = await getHistory();
    const latest = await getLatestRecord();
    const historyContains = existingHistory.some((record) => record.id === id);
    const latestContains = latest?.id === id;
    if (!historyContains && !latestContains) return false;

    if (historyContains) {
      await writeHistoryUnlocked(
        existingHistory.map((record) =>
          record.id === id ? parsedReplacement : record,
        ),
      );
    }
    if (latestContains) await setLatestRecordUnlocked(parsedReplacement);
    return true;
  });
}

export async function getResult(id: string): Promise<HistoryRecord | null> {
  const historyRecord = (await getHistory()).find((record) => record.id === id);
  if (historyRecord) return historyRecord;
  const latest = await getLatestRecord();
  return latest?.id === id ? latest : null;
}

export async function deleteHistoryItem(id: string): Promise<void> {
  await withStorageMutationLock(async () => {
    const existing = await getHistory();
    const next = existing.filter((record) => record.id !== id);
    if (next.length !== existing.length) await writeHistoryUnlocked(next);
    const latest = await getLatestRecord();
    if (latest?.id === id) {
      if (next[0]) {
        await setLatestRecordUnlocked(next[0]);
      } else {
        await chrome.storage.session.remove(STORAGE_KEYS.latest);
      }
    }
  });
}

function writeHistoryUnlocked(records: HistoryRecord[]): Promise<void> {
  return chrome.storage.local.set({ [STORAGE_KEYS.history]: records });
}

function setLatestRecordUnlocked(record: HistoryRecord): Promise<void> {
  return chrome.storage.session.set({ [STORAGE_KEYS.latest]: record });
}

function withStorageMutationLock<T>(work: () => Promise<T>): Promise<T> {
  return navigator.locks.request(STORAGE_MUTATION_LOCK, work);
}

export async function getWorkflowState(): Promise<WorkflowState> {
  const values = await chrome.storage.local.get(STORAGE_KEYS.workflow);
  const parsed = WorkflowStateSchema.safeParse(values[STORAGE_KEYS.workflow]);
  if (parsed.success) return parsed.data;
  return {
    status: "idle",
    actionId: null,
    message: "Ready",
    updatedAt: new Date().toISOString(),
  };
}

export async function setWorkflowState(state: WorkflowState): Promise<void> {
  const parsed = WorkflowStateSchema.parse(state);
  await chrome.storage.local.set({ [STORAGE_KEYS.workflow]: parsed });
}
