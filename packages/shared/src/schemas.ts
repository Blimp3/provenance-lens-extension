import { z } from "zod";

import {
  ACTION_ID,
  AUDIO_ACTION_ID,
  DOWNLOAD_ACTION_ID,
  MAX_IMAGE_BYTES,
  MAX_INLINE_IMAGE_BYTES,
  RESULT_SCHEMA_VERSION,
  VERIFICATION_POLICY_VERSION,
} from "./constants.js";

const boundedNullableString = z.string().trim().max(512).nullable();
const nullableIsoDateTime = z.iso.datetime({ offset: true }).nullable();

export const SupportedImageMimeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/webp",
]);
export type SupportedImageMime = z.infer<typeof SupportedImageMimeSchema>;

export const SupportedAudioMimeSchema = z.enum([
  "audio/mpeg",
  "audio/ogg",
  "audio/opus",
  "audio/aac",
  "audio/flac",
  "audio/wav",
  "audio/x-wav",
]);
export type SupportedAudioMime = z.infer<typeof SupportedAudioMimeSchema>;

export const SupportedMediaMimeSchema = z.union([
  SupportedImageMimeSchema,
  SupportedAudioMimeSchema,
]);
export type SupportedMediaMime = z.infer<typeof SupportedMediaMimeSchema>;

export const ActionIdSchema = z.enum([
  ACTION_ID,
  AUDIO_ACTION_ID,
  DOWNLOAD_ACTION_ID,
]);
export type ActionId = z.infer<typeof ActionIdSchema>;

export const MediaKindSchema = z.enum(["image", "audio"]);
export type MediaKind = z.infer<typeof MediaKindSchema>;

export const SignalOutcomeSchema = z.enum(["detected", "not_detected"]);
export const ValidationStateSchema = z.enum([
  "trusted",
  "valid",
  "invalid",
  "not_present",
]);

export const OpenAIC2PAResultSchema = z
  .object({
    type: z.literal("c2pa"),
    outcome: SignalOutcomeSchema,
    validation_state: ValidationStateSchema,
    issuer: boundedNullableString,
    model: boundedNullableString,
    generated_at: nullableIsoDateTime,
  })
  .strict();

export const OpenAISynthIDResultSchema = z
  .object({
    type: z.literal("synthid"),
    outcome: SignalOutcomeSchema,
    model: boundedNullableString,
    generated_at: nullableIsoDateTime,
  })
  .strict();

export const OpenAIResultSchema = z.discriminatedUnion("type", [
  OpenAIC2PAResultSchema,
  OpenAISynthIDResultSchema,
]);

export const OpenAIContentProvenanceResponseSchema = z
  .object({
    object: z.literal("content_provenance_check"),
    created_at: z.number().int().nonnegative().finite(),
    results: z.array(OpenAIResultSchema).min(1).max(10),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    for (const result of value.results) {
      if (seen.has(result.type)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate ${result.type} result entry.`,
          path: ["results"],
        });
      }
      seen.add(result.type);
    }
  });
export const NormalizedSignalSchema = z
  .object({
    type: z.enum(["c2pa", "synthid"]),
    outcome: SignalOutcomeSchema,
    validationState: ValidationStateSchema.nullable(),
    issuer: boundedNullableString,
    model: boundedNullableString,
    generatedAt: nullableIsoDateTime,
  })
  .strict();
export type NormalizedSignal = z.infer<typeof NormalizedSignalSchema>;

export const VerdictSchema = z.enum([
  "openai_signal_detected",
  "no_supported_openai_signal",
  "indeterminate",
]);

export const CacheableVerdictSchema = z.enum([
  "openai_signal_detected",
  "no_supported_openai_signal",
]);
export type CacheableVerdict = z.infer<typeof CacheableVerdictSchema>;

export const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u, "Expected a lowercase SHA-256 digest.");
export type Sha256 = z.infer<typeof Sha256Schema>;

export const VerificationPolicyVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._-]+$/u);

export const CacheSourceSchema = z.enum([
  "fresh",
  "local_cache",
  "server_cache",
]);
export type CacheSource = z.infer<typeof CacheSourceSchema>;

export const ContentCredentialsSchema = z
  .object({
    status: z.enum(["not_present", "verified", "invalid", "unavailable"]),
    signatureValid: z.boolean(),
    contentBindingValid: z.boolean(),
    signerTrusted: z.boolean(),
    issuer: boundedNullableString,
    actions: z
      .array(
        z
          .object({
            action: z.string().trim().min(1).max(128),
            digitalSourceType: z.string().trim().min(1).max(256).nullable(),
          })
          .strict(),
      )
      .max(20),
    aiDeclaration: z.enum(["generated", "edited"]).nullable(),
    validationCodes: z.array(z.string().trim().min(1).max(128)).max(30),
    trustListVersion: z.string().trim().min(1).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    const integrityVerified = value.signatureValid && value.contentBindingValid;
    if (
      (value.status === "verified" && !integrityVerified) ||
      (value.status !== "verified" &&
        (value.signerTrusted || value.aiDeclaration !== null)) ||
      (value.status === "not_present" &&
        (value.signatureValid ||
          value.contentBindingValid ||
          value.actions.length > 0))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Content Credentials evidence must agree with its verification status.",
      });
    }
  });
export type ContentCredentials = z.infer<typeof ContentCredentialsSchema>;

export const NormalizedProvenanceResultSchema = z
  .object({
    verdict: VerdictSchema,
    summary: z.string().trim().min(1).max(1_000),
    signals: z.array(NormalizedSignalSchema).max(10),
    warnings: z.array(z.string().trim().min(1).max(1_000)).max(10),
    checkedAt: z.iso.datetime({ offset: true }),
    requestId: z.string().uuid(),
    contentCredentials: ContentCredentialsSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasDetectedSignal = value.signals.some(
      (signal) => signal.outcome === "detected",
    );
    const hasReliableDetection = value.signals.some(
      (signal) =>
        signal.outcome === "detected" &&
        (signal.type === "synthid" ||
          signal.validationState === "trusted" ||
          signal.validationState === "valid"),
    );
    if (value.verdict === "openai_signal_detected" && !hasReliableDetection) {
      context.addIssue({
        code: "custom",
        message: "A detected verdict requires a reliable detected signal.",
        path: ["verdict"],
      });
    }
    if (value.verdict === "no_supported_openai_signal" && hasDetectedSignal) {
      context.addIssue({
        code: "custom",
        message: "A no-signal verdict cannot contain a detected signal.",
        path: ["verdict"],
      });
    }
  });
export type NormalizedProvenanceResult = z.infer<
  typeof NormalizedProvenanceResultSchema
>;

export const CacheableNormalizedProvenanceResultSchema =
  NormalizedProvenanceResultSchema.safeExtend({
    verdict: CacheableVerdictSchema,
  });
export type CacheableNormalizedProvenanceResult = z.infer<
  typeof CacheableNormalizedProvenanceResultSchema
>;

export const CacheMetadataSchema = z
  .object({
    source: CacheSourceSchema,
    originallyCheckedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    verificationPolicyVersion: VerificationPolicyVersionSchema,
    resultSchemaVersion: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.expiresAt) <= Date.parse(value.originallyCheckedAt)) {
      context.addIssue({
        code: "custom",
        message: "The cache expiration must follow the original check time.",
        path: ["expiresAt"],
      });
    }
  });
export type CacheMetadata = z.infer<typeof CacheMetadataSchema>;

export const VerificationResponseSchema = z
  .object({
    result: NormalizedProvenanceResultSchema,
    cache: CacheMetadataSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const cacheable = value.result.verdict !== "indeterminate";
    if (cacheable !== (value.cache !== null)) {
      context.addIssue({
        code: "custom",
        message:
          "Successful verdicts require cache metadata and indeterminate results must not be cached.",
        path: ["cache"],
      });
    }
  });
export type VerificationResponse = z.infer<typeof VerificationResponseSchema>;

export const CacheLookupRequestSchema = z
  .object({
    imageSha256: Sha256Schema,
    byteLength: z.number().int().positive().max(MAX_IMAGE_BYTES),
    validatedMimeType: SupportedMediaMimeSchema,
    verificationPolicyVersion: VerificationPolicyVersionSchema.default(
      VERIFICATION_POLICY_VERSION,
    ),
  })
  .strict();
export type CacheLookupRequest = z.infer<typeof CacheLookupRequestSchema>;

export const CacheLookupResponseSchema = z.discriminatedUnion("hit", [
  z
    .object({
      hit: z.literal(false),
      verificationPolicyVersion: VerificationPolicyVersionSchema,
    })
    .strict(),
  z
    .object({
      hit: z.literal(true),
      result: CacheableNormalizedProvenanceResultSchema,
      originallyCheckedAt: z.iso.datetime({ offset: true }),
      expiresAt: z.iso.datetime({ offset: true }),
      verificationPolicyVersion: VerificationPolicyVersionSchema,
      resultSchemaVersion: z.number().int().positive(),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        Date.parse(value.expiresAt) <= Date.parse(value.originallyCheckedAt)
      ) {
        context.addIssue({
          code: "custom",
          message: "The cache expiration must follow the original check time.",
          path: ["expiresAt"],
        });
      }
    }),
]);
export type CacheLookupResponse = z.infer<typeof CacheLookupResponseSchema>;

export const VerificationUploadMetadataSchema = z
  .object({
    imageSha256: Sha256Schema,
    byteLength: z.number().int().positive().max(MAX_IMAGE_BYTES),
    validatedMimeType: SupportedMediaMimeSchema,
    verificationPolicyVersion: VerificationPolicyVersionSchema.default(
      VERIFICATION_POLICY_VERSION,
    ),
    forceRecheck: z.boolean().default(false),
  })
  .strict();
export type VerificationUploadMetadata = z.infer<
  typeof VerificationUploadMetadataSchema
>;

export const LocalVerificationCacheRecordSchema = z
  .object({
    namespace: Sha256Schema,
    imageSha256: Sha256Schema,
    byteLength: z.number().int().positive().max(MAX_IMAGE_BYTES),
    validatedMimeType: SupportedMediaMimeSchema,
    verdict: CacheableVerdictSchema,
    result: CacheableNormalizedProvenanceResultSchema,
    originallyCheckedAt: z.iso.datetime({ offset: true }),
    lastAccessedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    verificationPolicyVersion: VerificationPolicyVersionSchema,
    resultSchemaVersion: z
      .number()
      .int()
      .positive()
      .default(RESULT_SCHEMA_VERSION),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.result.verdict !== value.verdict) {
      context.addIssue({
        code: "custom",
        message: "The cache verdict must match the normalized result verdict.",
        path: ["verdict"],
      });
    }
    if (Date.parse(value.expiresAt) <= Date.parse(value.originallyCheckedAt)) {
      context.addIssue({
        code: "custom",
        message: "The cache expiration must follow the original check time.",
        path: ["expiresAt"],
      });
    }
  });
export type LocalVerificationCacheRecord = z.infer<
  typeof LocalVerificationCacheRecordSchema
>;

export const ErrorCodeSchema = z.enum([
  "unsupported_image_type",
  "image_too_large",
  "unsupported_audio_type",
  "audio_too_large",
  "audio_too_long",
  "audio_duration_unknown",
  "image_retrieval_failed",
  "authentication_failed",
  "backend_unavailable",
  "backend_configuration_missing",
  "openai_api_key_missing",
  "openai_access_unavailable",
  "openai_rate_limit",
  "openai_server_error",
  "invalid_api_response",
  "request_timeout",
  "protected_page",
  "permission_denied",
  "user_cancelled",
  "invalid_request",
  "concurrency_limit",
  "hash_mismatch",
  "cache_policy_mismatch",
  "cache_unavailable",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ServerErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: ErrorCodeSchema,
        message: z.string().trim().min(1).max(1_000),
        requestId: z.string().uuid(),
        retryable: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type ServerErrorResponse = z.infer<typeof ServerErrorResponseSchema>;

const maxImageSelectionUrlLength =
  Math.ceil((MAX_INLINE_IMAGE_BYTES * 4) / 3) + 128;

export const ImageSelectionSchema = z
  .object({
    url: z.string().min(1).max(maxImageSelectionUrlLength),
    sourceKind: z.enum([
      "img",
      "picture",
      "background-image",
      "video-poster",
      "data-url",
      "blob-url",
    ]),
    pageOrigin: z.string().url().max(2_048),
    sourceHostname: z.string().trim().max(255),
    pageTitle: z.string().trim().max(256).nullable(),
    rect: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().finite().positive(),
        height: z.number().finite().positive(),
        viewportWidth: z.number().finite().positive(),
        viewportHeight: z.number().finite().positive(),
        devicePixelRatio: z.number().finite().positive().max(10),
      })
      .strict(),
    inlineBase64: z
      .string()
      .max(Math.ceil((MAX_INLINE_IMAGE_BYTES * 4) / 3) + 4)
      .optional(),
    inlineMime: SupportedImageMimeSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.inlineBase64 === undefined) !==
      (value.inlineMime === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Inline image bytes and MIME type must be supplied together.",
        path: ["inlineBase64"],
      });
    }

    let selectionUrl: URL;
    try {
      selectionUrl = new URL(value.url);
    } catch {
      context.addIssue({
        code: "custom",
        message: "The selected image URL is invalid.",
        path: ["url"],
      });
      return;
    }

    const protocol = selectionUrl.protocol;
    if (!["https:", "http:", "data:", "blob:"].includes(protocol)) {
      context.addIssue({
        code: "custom",
        message: "The selected image URL scheme is not supported.",
        path: ["url"],
      });
    }
    if (selectionUrl.username || selectionUrl.password) {
      context.addIssue({
        code: "custom",
        message: "Image URLs containing credentials are not supported.",
        path: ["url"],
      });
    }

    const expectedProtocol =
      value.sourceKind === "data-url"
        ? "data:"
        : value.sourceKind === "blob-url"
          ? "blob:"
          : null;
    if (expectedProtocol !== null && protocol !== expectedProtocol) {
      context.addIssue({
        code: "custom",
        message: "The image source kind does not match its URL scheme.",
        path: ["url"],
      });
    }
    if (value.sourceKind === "blob-url" && value.inlineBase64 === undefined) {
      context.addIssue({
        code: "custom",
        message: "Blob image bytes must be transferred with the selection.",
        path: ["inlineBase64"],
      });
    }

    const pageUrl = new URL(value.pageOrigin);
    if (
      !["http:", "https:"].includes(pageUrl.protocol) ||
      pageUrl.origin !== value.pageOrigin
    ) {
      context.addIssue({
        code: "custom",
        message: "The page origin must be an exact HTTP(S) origin.",
        path: ["pageOrigin"],
      });
    }
  });
export type ImageSelection = z.infer<typeof ImageSelectionSchema>;

export const VerificationModeSchema = z.enum(["website", "api"]);
export type VerificationMode = z.infer<typeof VerificationModeSchema>;

export const AcknowledgedVerificationModesSchema = z
  .array(VerificationModeSchema)
  .max(2)
  .refine(
    (modes) => new Set(modes).size === modes.length,
    "Each verification mode may only be acknowledged once.",
  );

export const PICKER_RUNTIME_VERSION = "0.7.0" as const;

export const PickerRuntimeMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("page-bind"),
      runtimeVersion: z.literal(PICKER_RUNTIME_VERSION),
      sessionToken: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      type: z.literal("picker-start"),
      runtimeVersion: z.literal(PICKER_RUNTIME_VERSION),
      sessionToken: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      type: z.literal("picker-stop"),
      runtimeVersion: z.literal(PICKER_RUNTIME_VERSION),
      sessionToken: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      type: z.literal("show-toast"),
      runtimeVersion: z.literal(PICKER_RUNTIME_VERSION),
      sessionToken: z.string().uuid(),
      tone: z.enum(["detected", "no-signal", "error"]),
      title: z.string().trim().min(1).max(100),
      message: z.string().trim().min(1).max(512),
      resultId: z.string().uuid().nullable(),
    })
    .strict(),
]);
export type PickerRuntimeMessage = z.infer<typeof PickerRuntimeMessageSchema>;

export const ResultToastBindingSchema = z
  .object({
    resultId: z.string().uuid(),
    sessionToken: z.string().uuid(),
    tabId: z.number().int().nonnegative(),
    frameId: z.number().int().nonnegative(),
    documentId: z.string().trim().min(1).max(512),
  })
  .strict();
export type ResultToastBinding = z.infer<typeof ResultToastBindingSchema>;
export const ResultToastBindingsSchema = z
  .array(ResultToastBindingSchema)
  .max(32);

export const ExtensionMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("start-action"),
      actionId: ActionIdSchema,
      trigger: z.enum(["popup", "keyboard"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("picker-selected"),
      sessionToken: z.string().uuid(),
      selection: ImageSelectionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("picker-cancelled"),
      sessionToken: z.string().uuid(),
    })
    .strict(),
  z.object({ type: z.literal("cancel-active") }).strict(),
  z
    .object({
      type: z.literal("verify-screenshot"),
      fallbackId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      type: z.literal("download-fallback"),
      resultId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      type: z.literal("resume-permission"),
      pendingId: z.string().uuid(),
      verificationMode: VerificationModeSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("open-result-details"),
      sessionToken: z.string().uuid(),
      resultId: z.string().uuid(),
    })
    .strict(),
]);
export type ExtensionMessage = z.infer<typeof ExtensionMessageSchema>;

export const HistoryRetentionSchema = z.union([
  z.literal(0),
  z.literal(10),
  z.literal(20),
  z.literal(50),
]);
export type HistoryRetention = z.infer<typeof HistoryRetentionSchema>;

export const HistoryRecordSchema = z
  .object({
    id: z.string().uuid(),
    actionId: ActionIdSchema,
    createdAt: z.iso.datetime({ offset: true }),
    sourceHostname: z.string().trim().max(255),
    pageTitle: z.string().trim().max(256).nullable(),
    mediaKind: MediaKindSchema.optional(),
    inputKind: z.enum(["original_file", "screenshot_copy"]),
    imageSha256: Sha256Schema.nullable(),
    result: NormalizedProvenanceResultSchema,
    cache: CacheMetadataSchema.nullable(),
    errorCode: ErrorCodeSchema.nullable(),
    manualFallbackAvailable: z.boolean(),
    screenshotFallbackAvailable: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const audio = value.actionId === AUDIO_ACTION_ID;
    if (
      audio !== (value.mediaKind === "audio") ||
      (audio &&
        (value.inputKind !== "original_file" ||
          value.manualFallbackAvailable ||
          value.screenshotFallbackAvailable ||
          value.result.contentCredentials !== undefined ||
          value.result.signals.some((signal) => signal.type !== "synthid")))
    ) {
      context.addIssue({
        code: "custom",
        message: "The saved media kind and evidence must match the action.",
      });
    }
  });
export type HistoryRecord = z.infer<typeof HistoryRecordSchema>;

export const ExtensionSettingsSchema = z
  .object({
    verificationMode: VerificationModeSchema.default("website"),
    acknowledgedVerificationModes: AcknowledgedVerificationModesSchema.default(
      [],
    ),
    backendBaseUrl: z.string().trim().min(1).max(2_048),
    clientToken: z.string().max(512),
    historyRetention: HistoryRetentionSchema,
    screenshotFallbackEnabled: z.boolean(),
    includePageTitle: z.boolean(),
    debugMode: z.boolean(),
    localCacheLimit: z.number().int().min(10).max(1_000),
    disclosureVersion: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    let backendUrl: URL;
    try {
      backendUrl = new URL(value.backendBaseUrl);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Enter a valid backend URL.",
        path: ["backendBaseUrl"],
      });
      return;
    }

    const loopback =
      backendUrl.hostname === "127.0.0.1" ||
      backendUrl.hostname === "localhost" ||
      backendUrl.hostname === "[::1]";
    if (
      backendUrl.username ||
      backendUrl.password ||
      backendUrl.search ||
      backendUrl.hash ||
      (backendUrl.protocol !== "https:" &&
        !(backendUrl.protocol === "http:" && loopback))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Use HTTPS for remote backends and omit credentials, queries, and fragments.",
        path: ["backendBaseUrl"],
      });
    }
  });
export type ExtensionSettings = z.infer<typeof ExtensionSettingsSchema>;

export const WorkflowStateSchema = z
  .object({
    status: z.enum(["idle", "picking", "retrieving", "verifying", "error"]),
    actionId: ActionIdSchema.nullable(),
    message: z.string().trim().max(512),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;
