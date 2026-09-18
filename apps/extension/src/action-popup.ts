import type { HistoryRecord } from "@provenance-lens/shared";

import { setWindowLatestRecord } from "./storage.js";

type ActionPopupBrowser = {
  getTab: (tabId: number) => Promise<{ windowId: number }>;
  openPopup: ((options: { windowId: number }) => Promise<void>) | undefined;
  setWindowLatest: (
    windowId: number,
    record: HistoryRecord,
  ) => Promise<boolean>;
};

export async function openActionPopup(
  tabId: number,
  record: HistoryRecord,
  browser: ActionPopupBrowser = {
    getTab: (id) => chrome.tabs.get(id),
    openPopup:
      typeof chrome.action.openPopup === "function"
        ? (options) => chrome.action.openPopup(options)
        : undefined,
    setWindowLatest: setWindowLatestRecord,
  },
): Promise<boolean> {
  if (!browser.openPopup) return false;
  try {
    const tab = await browser.getTab(tabId);
    if (!(await browser.setWindowLatest(tab.windowId, record))) return false;
    await browser.openPopup({ windowId: tab.windowId });
    return true;
  } catch {
    return false;
  }
}
