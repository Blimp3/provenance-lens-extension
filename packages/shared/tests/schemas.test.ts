import {
  ACTION_ID,
  ExtensionMessageSchema,
  ExtensionSettingsSchema,
  ImageSelectionSchema,
  NormalizedProvenanceResultSchema,
  PICKER_RUNTIME_VERSION,
  PickerRuntimeMessageSchema,
  ResultToastBindingsSchema,
} from "../src/index.js";

describe("shared runtime schemas", () => {
  it("accepts a known extension message", () => {
    expect(
      ExtensionMessageSchema.parse({
        type: "start-action",
        actionId: ACTION_ID,
        trigger: "popup",
      }),
    ).toEqual({
      type: "start-action",
      actionId: ACTION_ID,
      trigger: "popup",
    });
  });

  it("rejects unknown extension messages", () => {
    expect(
      ExtensionMessageSchema.safeParse({
        type: "fetch-url",
        url: "http://internal/",
      }).success,
    ).toBe(false);
  });

  it("accepts only bounded in-page toast messages without a destination URL", () => {
    const message = {
      type: "show-toast",
      runtimeVersion: PICKER_RUNTIME_VERSION,
      sessionToken: "123e4567-e89b-42d3-a456-426614174000",
      tone: "error",
      title: "Verification failed",
      message: "The backend is unavailable.",
      resultId: "223e4567-e89b-42d3-a456-426614174000",
    };
    expect(PickerRuntimeMessageSchema.safeParse(message).success).toBe(true);
    expect(
      PickerRuntimeMessageSchema.safeParse({
        ...message,
        detailsUrl: "javascript:alert(1)",
      }).success,
    ).toBe(false);
    expect(
      PickerRuntimeMessageSchema.safeParse({
        ...message,
        message: "x".repeat(513),
      }).success,
    ).toBe(false);
  });

  it("accepts only strict UUID page bindings", () => {
    expect(
      PickerRuntimeMessageSchema.safeParse({
        type: "page-bind",
        runtimeVersion: PICKER_RUNTIME_VERSION,
        sessionToken: "123e4567-e89b-42d3-a456-426614174000",
      }).success,
    ).toBe(true);
    expect(
      PickerRuntimeMessageSchema.safeParse({
        type: "page-bind",
        runtimeVersion: PICKER_RUNTIME_VERSION,
        sessionToken: "not-a-token",
      }).success,
    ).toBe(false);
    expect(
      PickerRuntimeMessageSchema.safeParse({
        type: "page-bind",
        runtimeVersion: "0.4.0",
        sessionToken: "123e4567-e89b-42d3-a456-426614174000",
      }).success,
    ).toBe(false);
  });

  it("accepts only bounded, strict persisted toast bindings", () => {
    const binding = {
      resultId: "123e4567-e89b-42d3-a456-426614174000",
      sessionToken: "223e4567-e89b-42d3-a456-426614174000",
      tabId: 7,
      frameId: 3,
      documentId: "document-1",
    };
    expect(ResultToastBindingsSchema.safeParse([binding]).success).toBe(true);
    expect(
      ResultToastBindingsSchema.safeParse([
        { ...binding, injected: "javascript:alert(1)" },
      ]).success,
    ).toBe(false);
    expect(
      ResultToastBindingsSchema.safeParse(Array(33).fill(binding)).success,
    ).toBe(false);
  });

  it("accepts only UUID-bound result-details requests", () => {
    const request = {
      type: "open-result-details",
      sessionToken: "123e4567-e89b-42d3-a456-426614174000",
      resultId: "223e4567-e89b-42d3-a456-426614174000",
    };
    expect(ExtensionMessageSchema.safeParse(request).success).toBe(true);
    expect(
      ExtensionMessageSchema.safeParse({
        ...request,
        resultId: "../../settings.html",
      }).success,
    ).toBe(false);
  });

  it.each(["website", "api"])(
    "accepts a resume-permission acknowledgement for %s mode",
    (verificationMode) => {
      expect(
        ExtensionMessageSchema.safeParse({
          type: "resume-permission",
          pendingId: "123e4567-e89b-42d3-a456-426614174000",
          verificationMode,
        }).success,
      ).toBe(true);
    },
  );

  it.each([
    {
      type: "resume-permission",
      pendingId: "123e4567-e89b-42d3-a456-426614174000",
    },
    {
      type: "resume-permission",
      pendingId: "123e4567-e89b-42d3-a456-426614174000",
      verificationMode: "automatic",
    },
  ])("rejects an invalid resume-permission acknowledgement", (message) => {
    expect(ExtensionMessageSchema.safeParse(message).success).toBe(false);
  });

  it("rejects malformed normalized results", () => {
    expect(
      NormalizedProvenanceResultSchema.safeParse({
        verdict: "human_made",
        summary: "No",
      }).success,
    ).toBe(false);
  });

  it.each([
    {
      verdict: "openai_signal_detected",
      signals: [],
    },
    {
      verdict: "no_supported_openai_signal",
      signals: [
        {
          type: "synthid",
          outcome: "detected",
          validationState: null,
          issuer: null,
          model: null,
          generatedAt: null,
        },
      ],
    },
  ])("rejects a verdict that contradicts its signals", (contradiction) => {
    expect(
      NormalizedProvenanceResultSchema.safeParse({
        ...contradiction,
        summary: "Contradictory result.",
        warnings: [],
        checkedAt: "2026-09-01T10:00:00.000Z",
        requestId: "123e4567-e89b-42d3-a456-426614174000",
      }).success,
    ).toBe(false);
  });

  it("migrates persisted settings without a mode to Website mode", () => {
    const migrated = ExtensionSettingsSchema.parse({
      backendBaseUrl: "http://127.0.0.1:8787",
      clientToken: "",
      historyRetention: 20,
      screenshotFallbackEnabled: false,
      includePageTitle: true,
      debugMode: false,
      localCacheLimit: 100,
      disclosureVersion: 0,
    });
    expect(migrated.verificationMode).toBe("website");
    expect(migrated.acknowledgedVerificationModes).toEqual([]);
  });

  it("bounds and deduplicates mode acknowledgements", () => {
    const baseSettings = {
      backendBaseUrl: "http://127.0.0.1:8787",
      clientToken: "",
      historyRetention: 20,
      screenshotFallbackEnabled: false,
      includePageTitle: true,
      debugMode: false,
      localCacheLimit: 100,
      disclosureVersion: 2,
    };
    expect(
      ExtensionSettingsSchema.safeParse({
        ...baseSettings,
        acknowledgedVerificationModes: ["website", "api"],
      }).success,
    ).toBe(true);
    expect(
      ExtensionSettingsSchema.safeParse({
        ...baseSettings,
        acknowledgedVerificationModes: ["website", "website"],
      }).success,
    ).toBe(false);
    expect(
      ExtensionSettingsSchema.safeParse({
        ...baseSettings,
        acknowledgedVerificationModes: ["website", "api", "website"],
      }).success,
    ).toBe(false);
  });

  it.each(["website", "api"])(
    "accepts the %s verification mode",
    (verificationMode) => {
      expect(
        ExtensionSettingsSchema.safeParse({
          verificationMode,
          backendBaseUrl: "http://127.0.0.1:8787",
          clientToken: "",
          historyRetention: 20,
          screenshotFallbackEnabled: false,
          includePageTitle: true,
          debugMode: false,
          localCacheLimit: 100,
          disclosureVersion: 0,
        }).success,
      ).toBe(true);
    },
  );

  it("rejects an unknown verification mode", () => {
    expect(
      ExtensionSettingsSchema.safeParse({
        verificationMode: "automatic-website",
        backendBaseUrl: "http://127.0.0.1:8787",
        clientToken: "",
        historyRetention: 20,
        screenshotFallbackEnabled: false,
        includePageTitle: true,
        debugMode: false,
        localCacheLimit: 100,
        disclosureVersion: 0,
      }).success,
    ).toBe(false);
  });

  it("requires bounded inline bytes for blob selections", () => {
    const selection = {
      url: "blob:https://example.test/123e4567-e89b-42d3-a456-426614174000",
      sourceKind: "blob-url",
      pageOrigin: "https://example.test",
      sourceHostname: "example.test",
      pageTitle: null,
      rect: {
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        viewportWidth: 100,
        viewportHeight: 100,
        devicePixelRatio: 1,
      },
    };
    expect(ImageSelectionSchema.safeParse(selection).success).toBe(false);
    expect(
      ImageSelectionSchema.safeParse({
        ...selection,
        inlineBase64: "iVBORw0KGgo=",
        inlineMime: "image/png",
      }).success,
    ).toBe(true);
  });

  it("rejects a page URL where an exact origin is required", () => {
    const parsed = ImageSelectionSchema.safeParse({
      url: "https://example.test/image.png",
      sourceKind: "img",
      pageOrigin: "https://example.test/page?secret=1",
      sourceHostname: "example.test",
      pageTitle: null,
      rect: {
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        viewportWidth: 100,
        viewportHeight: 100,
        devicePixelRatio: 1,
      },
    });
    expect(parsed.success).toBe(false);
  });

  it.each([
    "javascript:alert(1)",
    "file:///private/image.png",
    "https://user:secret@example.test/image.png",
  ])("rejects an unsafe selected image URL: %s", (url) => {
    expect(
      ImageSelectionSchema.safeParse({
        url,
        sourceKind: "img",
        pageOrigin: "https://example.test",
        sourceHostname: "example.test",
        pageTitle: null,
        rect: {
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          viewportWidth: 100,
          viewportHeight: 100,
          devicePixelRatio: 1,
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    "http://public.example.test",
    "https://user:secret@example.test",
    "https://example.test?token=secret",
  ])("rejects an unsafe backend URL in persisted settings: %s", (url) => {
    expect(
      ExtensionSettingsSchema.safeParse({
        backendBaseUrl: url,
        clientToken: "client-token",
        historyRetention: 20,
        screenshotFallbackEnabled: false,
        includePageTitle: false,
        debugMode: false,
        localCacheLimit: 100,
        disclosureVersion: 0,
      }).success,
    ).toBe(false);
  });
});
