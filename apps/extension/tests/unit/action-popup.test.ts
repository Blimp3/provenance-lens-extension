import type { HistoryRecord } from "@provenance-lens/shared";
import { describe, expect, it, vi } from "vitest";

import { openActionPopup } from "../../src/action-popup.js";

const record: HistoryRecord = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  actionId: "verify-openai-provenance",
  createdAt: "2026-09-02T14:46:50.000Z",
  sourceHostname: "page.example",
  pageTitle: null,
  inputKind: "original_file",
  imageSha256: null,
  result: {
    verdict: "openai_signal_detected",
    summary: "Detected signals: SynthID.",
    signals: [],
    warnings: [],
    checkedAt: "2026-09-02T14:46:50.000Z",
    requestId: "223e4567-e89b-42d3-a456-426614174000",
  },
  cache: null,
  errorCode: null,
  manualFallbackAvailable: false,
  screenshotFallbackAvailable: false,
};

describe("action popup reopening", () => {
  it("binds the result before opening in the selected tab's window", async () => {
    const calls: string[] = [];
    const openPopup = vi.fn(() => {
      calls.push("open");
      return Promise.resolve();
    });
    const setWindowLatest = vi.fn(() => {
      calls.push("bind");
      return Promise.resolve(true);
    });

    await expect(
      openActionPopup(7, record, {
        getTab: vi.fn().mockResolvedValue({ windowId: 11 }),
        openPopup,
        setWindowLatest,
      }),
    ).resolves.toBe(true);
    expect(setWindowLatest).toHaveBeenCalledWith(11, record);
    expect(openPopup).toHaveBeenCalledWith({ windowId: 11 });
    expect(calls).toEqual(["bind", "open"]);
  });

  it("does not open for an unsupported browser or a stale window result", async () => {
    const setWindowLatest = vi.fn().mockResolvedValue(true);
    await expect(
      openActionPopup(7, record, {
        getTab: vi.fn().mockResolvedValue({ windowId: 11 }),
        openPopup: undefined,
        setWindowLatest,
      }),
    ).resolves.toBe(false);
    expect(setWindowLatest).not.toHaveBeenCalled();

    const openPopup = vi.fn();
    await expect(
      openActionPopup(7, record, {
        getTab: vi.fn().mockResolvedValue({ windowId: 11 }),
        openPopup,
        setWindowLatest: vi.fn().mockResolvedValue(false),
      }),
    ).resolves.toBe(false);
    expect(openPopup).not.toHaveBeenCalled();
  });

  it("keeps existing result notices as fallback when reopening fails", async () => {
    await expect(
      openActionPopup(7, record, {
        getTab: vi.fn().mockRejectedValue(new Error("Tab closed")),
        openPopup: vi.fn(),
        setWindowLatest: vi.fn(),
      }),
    ).resolves.toBe(false);
  });
});
