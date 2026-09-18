import {
  NormalizedProvenanceResultSchema,
  resultLabel,
  type IntegrationOperationStatus,
  type IntegrationPeriod,
  type IntegrationStats,
  type HistoryRecord,
  type Sha256,
} from "@provenance-lens/shared";

import {
  clearHistory,
  deleteHistoryItem,
  getHistory,
  STORAGE_KEYS,
} from "../storage.js";
import {
  deleteIntegrationArchive,
  deleteIntegrationHistory,
  deleteIntegrationMedia,
  getAllIntegrationHistory,
  getIntegrationSession,
  getIntegrationStats,
} from "../integration-client.js";

const list = required<HTMLUListElement>("history-list");
const filter = required<HTMLSelectElement>("history-filter");
const period = required<HTMLSelectElement>("history-period");
const status = required<HTMLElement>("history-status");
const stats = required<HTMLElement>("history-stats");

filter.addEventListener("change", () => {
  void render();
});
period.addEventListener("change", () => {
  void render();
});
required<HTMLButtonElement>("clear-history").addEventListener("click", () => {
  void clearAll();
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[STORAGE_KEYS.history]) void render();
});
window.addEventListener("focus", () => void render());
void render();

async function render(): Promise<void> {
  const session = await getIntegrationSession().catch(() => null);
  if (session) {
    await renderIntegrationHistory();
    return;
  }
  stats.textContent = "Standalone history is stored only in this browser.";
  const records = await getHistory();
  const selected = filter.value;
  const visible = records.filter((record) => {
    if (selected === "detected")
      return record.result.verdict === "openai_signal_detected";
    if (selected === "not-detected")
      return record.result.verdict === "no_supported_openai_signal";
    if (selected === "error")
      return (
        record.result.verdict === "indeterminate" || record.errorCode !== null
      );
    return true;
  });
  list.replaceChildren(...visible.map(renderRecord));
  status.textContent = records.length
    ? `${visible.length} of ${records.length} result${records.length === 1 ? "" : "s"} shown.`
    : "No saved results.";
  status.className = "status";
}

async function renderIntegrationHistory(): Promise<void> {
  const selectedPeriod = parsePeriod(period.value);
  try {
    const [history, summary] = await Promise.all([
      getAllIntegrationHistory(selectedPeriod),
      getIntegrationStats(selectedPeriod),
    ]);
    const visible = history.operations.filter((operation) =>
      matchesIntegrationFilter(operation, filter.value),
    );
    list.replaceChildren(...visible.map(renderIntegrationRecord));
    status.textContent = history.operations.length
      ? `${visible.length} of ${history.operations.length} connected operation${history.operations.length === 1 ? "" : "s"} shown.${history.nextCursor ? " Narrow the period to view older operations." : ""}`
      : "No connected operations in this period.";
    status.className = "status";
    renderIntegrationStats(summary);
  } catch {
    list.replaceChildren();
    status.textContent =
      "DigiBot history could not be loaded. Check the connection in Settings.";
    status.className = "status error";
    stats.textContent = "Connected statistics are unavailable.";
  }
}

function renderIntegrationStats(summary: IntegrationStats): void {
  stats.textContent =
    `Checks ${summary.checksCompleted}/${summary.checksRequested} (${summary.checksFailed} failed, ${summary.freshChecks} fresh, ${summary.cachedChecks} cached) · ` +
    `Downloads ${summary.downloadsConfirmed}/${summary.downloadsRequested} (${summary.downloadsFailed} failed) · ` +
    `${summary.uniqueMedia} unique media · ${summary.savedOriginals} saved originals · ` +
    `${summary.unresolvedArchives} archive${summary.unresolvedArchives === 1 ? "" : "s"} unresolved`;
}

function renderIntegrationRecord(
  operation: IntegrationOperationStatus,
): HTMLLIElement {
  const item = document.createElement("li");
  item.className = `history-item ${integrationStateClass(operation)}`;
  const row = document.createElement("div");
  row.className = "row";
  const text = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = integrationTitle(operation);
  const meta = document.createElement("div");
  meta.className = "muted small";
  meta.textContent = `${operation.action === "check" ? "Check" : "Download"} · ${formatDate(operation.requestedAt)} · ${operation.mediaSha256 ? `SHA-256 ${operation.mediaSha256}` : "Media digest pending"}`;
  text.append(title, meta);
  row.append(text);
  const actions = document.createElement("div");
  actions.className = "actions";
  const mediaSha256 = operation.mediaSha256;
  if (operation.archive.deliveryState === "confirmed" && mediaSha256) {
    const removeArchive = document.createElement("button");
    removeArchive.type = "button";
    removeArchive.className = "secondary";
    removeArchive.textContent = "Delete Telegram copy";
    removeArchive.addEventListener("click", () => {
      void deleteIntegrationArchiveAndRefresh(mediaSha256);
    });
    actions.append(removeArchive);
  }
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger";
  remove.textContent = "Delete history";
  remove.addEventListener("click", () => {
    void deleteIntegrationHistoryAndRefresh(operation.operationId);
  });
  actions.append(remove);
  if (mediaSha256) {
    const removeMedia = document.createElement("button");
    removeMedia.type = "button";
    removeMedia.className = "danger";
    removeMedia.textContent = "Delete media + history";
    removeMedia.addEventListener("click", () => {
      void deleteIntegrationMediaAndRefresh(mediaSha256);
    });
    actions.append(removeMedia);
  }
  row.append(actions);
  const summary = document.createElement("p");
  summary.className = "muted small";
  summary.textContent = integrationSummary(operation);
  item.append(row, summary);
  return item;
}

async function deleteIntegrationHistoryAndRefresh(
  operationId: string,
): Promise<void> {
  try {
    await deleteIntegrationHistory(operationId);
    await render();
  } catch {
    status.textContent = "The connected history item could not be deleted.";
    status.className = "status error";
  }
}

async function deleteIntegrationArchiveAndRefresh(
  mediaSha256: Sha256,
): Promise<void> {
  try {
    await deleteIntegrationArchive(mediaSha256);
    await render();
  } catch {
    status.textContent = "The Telegram copy could not be deleted.";
    status.className = "status error";
  }
}

async function deleteIntegrationMediaAndRefresh(
  mediaSha256: Sha256,
): Promise<void> {
  try {
    await deleteIntegrationMedia(mediaSha256);
    await render();
  } catch {
    status.textContent =
      "The connected media and its history could not be deleted.";
    status.className = "status error";
  }
}

function renderRecord(record: HistoryRecord): HTMLLIElement {
  const item = document.createElement("li");
  item.className = `history-item ${resultStateClass(record.result.verdict)}`;
  const row = document.createElement("div");
  row.className = "row";
  const text = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = resultLabel(record.result, record.mediaKind);
  const meta = document.createElement("div");
  meta.className = "muted small";
  meta.textContent = `${record.sourceHostname || "unknown"} · ${formatDate(record.createdAt)} · ${record.mediaKind === "audio" ? "Audio file" : record.inputKind === "screenshot_copy" ? "Screenshot copy" : "Original image"}`;
  text.append(title, meta);
  row.append(text);
  const actions = document.createElement("div");
  actions.className = "actions";
  const details = document.createElement("a");
  details.className = "button secondary";
  details.href = `details.html?id=${encodeURIComponent(record.id)}`;
  details.textContent = "Details";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger";
  remove.textContent = "Delete";
  remove.addEventListener("click", () => {
    void deleteOne(record.id);
  });
  actions.append(details, remove);
  row.append(actions);
  const summary = document.createElement("p");
  summary.className = "muted small";
  summary.textContent = NormalizedProvenanceResultSchema.safeParse(
    record.result,
  ).success
    ? record.result.summary
    : "The saved result is unavailable.";
  item.append(row, summary);
  return item;
}

async function deleteOne(id: string): Promise<void> {
  await deleteHistoryItem(id);
  await render();
}

async function clearAll(): Promise<void> {
  if (await getIntegrationSession().catch(() => null)) {
    const selectedPeriod = parsePeriod(period.value);
    try {
      const history = await getAllIntegrationHistory(selectedPeriod);
      for (const operation of history.operations)
        await deleteIntegrationHistory(operation.operationId);
      await render();
    } catch {
      status.textContent = "Connected history could not be cleared.";
      status.className = "status error";
    }
    return;
  }
  await clearHistory();
  await render();
}

function matchesIntegrationFilter(
  operation: IntegrationOperationStatus,
  selected: string,
): boolean {
  if (selected === "detected")
    return (
      operation.envelope?.result?.evidence.verdict === "openai_signal_detected"
    );
  if (selected === "not-detected")
    return (
      operation.envelope?.result?.evidence.verdict ===
      "no_supported_openai_signal"
    );
  if (selected === "error")
    return (
      operation.state === "failed" ||
      operation.archive.deliveryState === "failed" ||
      operation.archive.deliveryState === "unknown"
    );
  return true;
}

function integrationTitle(operation: IntegrationOperationStatus): string {
  const evidence = operation.envelope?.result?.evidence;
  if (evidence) {
    const mediaKind = operation.envelope?.media.mimeType.startsWith("audio/")
      ? "audio"
      : "image";
    return resultLabel(evidence, mediaKind);
  }
  if (operation.state === "failed") return "Connected operation failed";
  if (operation.action === "download") return "Original image download";
  return `Connected check ${operation.state}`;
}

function integrationSummary(operation: IntegrationOperationStatus): string {
  if (operation.error) return operation.error.message;
  const archive = operation.archive.deliveryState;
  const archiveText =
    archive === "confirmed"
      ? "Telegram copy saved."
      : archive === "not_required"
        ? "No Telegram copy requested."
        : `Telegram copy ${archive}.`;
  const evidence = operation.envelope?.result?.evidence;
  const segmentText = operation.segment
    ? ` Segment ${operation.segment.startSeconds}–${operation.segment.endSeconds} seconds.`
    : "";
  return evidence
    ? `${evidence.summary}${segmentText} ${archiveText}`
    : `${segmentText.trim()}${segmentText ? " " : ""}${archiveText}`;
}

function integrationStateClass(operation: IntegrationOperationStatus): string {
  if (
    operation.state === "failed" ||
    operation.archive.deliveryState === "failed" ||
    operation.archive.deliveryState === "unknown"
  )
    return "result-error";
  if (operation.envelope?.result?.evidence.verdict === "openai_signal_detected")
    return "result-detected";
  if (operation.state === "completed") return "result-none";
  return "";
}

function parsePeriod(value: string): IntegrationPeriod {
  return value === "24h" || value === "7d" || value === "30d" ? value : "all";
}

function resultStateClass(verdict: string): string {
  if (verdict === "openai_signal_detected") return "result-detected";
  if (verdict === "no_supported_openai_signal") return "result-none";
  return "result-error";
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleString();
}

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
}
