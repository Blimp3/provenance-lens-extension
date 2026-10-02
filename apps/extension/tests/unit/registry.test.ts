import {
  ACTION_ID,
  AUDIO_ACTION_ID,
  DOWNLOAD_ACTION_ID,
  LINK_ACTION_ID,
  PICK_VIDEO_ACTION_ID,
  type ExtensionSettings,
} from "@provenance-lens/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACTION_REGISTRY,
  getActionDefinition,
} from "../../src/actions/registry.js";

const mocks = vi.hoisted(() => ({
  verifySelectionOnWebsite: vi.fn(),
  verifySelection: vi.fn(),
}));

vi.mock("../../src/actions/verify-openai-website.js", () => ({
  verifySelectionOnWebsite: mocks.verifySelectionOnWebsite,
}));

vi.mock("../../src/actions/verify-openai-provenance.js", () => ({
  verifySelection: mocks.verifySelection,
}));

const selection = {
  url: "https://page.example/image.png",
  sourceKind: "img" as const,
  pageOrigin: "https://page.example",
  sourceHostname: "page.example",
  pageTitle: "Fixture",
  rect: {
    x: 0,
    y: 0,
    width: 2,
    height: 2,
    viewportWidth: 100,
    viewportHeight: 100,
    devicePixelRatio: 1,
  },
};

const websiteSettings: ExtensionSettings = {
  verificationMode: "website",
  acknowledgedVerificationModes: ["website"],
  backendBaseUrl: "http://127.0.0.1:8787",
  clientToken: "",
  historyRetention: 20,
  screenshotFallbackEnabled: false,
  includePageTitle: true,
  debugMode: false,
  localCacheLimit: 100,
  disclosureVersion: 2,
};

describe("central action registry", () => {
  beforeEach(() => {
    mocks.verifySelectionOnWebsite.mockReset();
    mocks.verifySelection.mockReset();
  });

  it("dispatches the OpenAI provenance action through one registered definition", () => {
    const action = getActionDefinition(ACTION_ID);
    expect(action).toBeDefined();
    expect(action?.id).toBe(ACTION_ID);
    expect(action?.triggerLabel).toBe("Verify an image on this page");
    expect(action?.resultType).toBe("mode-dependent");
    expect(action?.settings).toContain("verificationMode");
    expect(action?.handler).toBeTypeOf("function");
    expect(ACTION_REGISTRY).toHaveLength(5);
    expect(ACTION_REGISTRY.map((action) => action.id)).toEqual([
      ACTION_ID,
      DOWNLOAD_ACTION_ID,
      AUDIO_ACTION_ID,
      LINK_ACTION_ID,
      PICK_VIDEO_ACTION_ID,
    ]);
  });

  it("lists the page-link action after the image actions and keeps it off the image picker", () => {
    const action = getActionDefinition(LINK_ACTION_ID);
    expect(action?.inputType).toBe("page-link");
    expect(action?.triggerLabel).toBe("Send this page's link to Telegram");
    expect(action?.resultType).toBe("telegram-delivery");
    expect(action?.settings).toEqual([]);
    expect(action?.handler).toBeTypeOf("function");
  });

  it("sends a picked video link through the page-link handler", () => {
    const action = getActionDefinition(PICK_VIDEO_ACTION_ID);
    expect(action?.inputType).toBe("video-pick");
    expect(action?.triggerLabel).toBe("Pick a video on this page");
    expect(action?.resultType).toBe("telegram-delivery");
    expect(action?.settings).toEqual([]);
    expect(action?.handler).toBe(getActionDefinition(LINK_ACTION_ID)?.handler);
  });

  it("uses the official OpenAI Verify website after a Website-mode pick", async () => {
    mocks.verifySelectionOnWebsite.mockResolvedValue({
      kind: "website",
      status: "opened",
      message:
        "The exact image was downloaded. Upload it to OpenAI Verify to review its supported provenance signals.",
    });
    const action = getActionDefinition(ACTION_ID);
    await expect(
      action?.handler({
        selection,
        settings: websiteSettings,
        retrieval: {},
      }),
    ).resolves.toMatchObject({ kind: "website", status: "opened" });
    expect(mocks.verifySelectionOnWebsite).toHaveBeenCalledWith(selection, {});
    expect(mocks.verifySelection).not.toHaveBeenCalled();
  });

  it("keeps API mode on the backend verification action", async () => {
    mocks.verifySelection.mockResolvedValue({
      result: {
        verdict: "indeterminate",
        summary: "The image could not be verified.",
        signals: [],
        warnings: [],
        checkedAt: "2026-09-01T00:00:00.000Z",
        requestId: "123e4567-e89b-42d3-a456-426614174000",
      },
      imageSha256: null,
      cache: null,
      errorCode: "backend_unavailable",
      retrieved: null,
      manualFallbackAvailable: false,
      screenshotFallbackAvailable: false,
    });
    const action = getActionDefinition(ACTION_ID);
    await expect(
      action?.handler({
        selection,
        settings: { ...websiteSettings, verificationMode: "api" },
        retrieval: {},
      }),
    ).resolves.toMatchObject({ kind: "api" });
    expect(mocks.verifySelection).toHaveBeenCalledTimes(1);
    expect(mocks.verifySelectionOnWebsite).not.toHaveBeenCalled();
  });
});
