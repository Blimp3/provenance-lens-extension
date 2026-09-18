import { z } from "zod";

import { MAX_AUDIO_BYTES, MAX_AUDIO_DURATION_SECONDS } from "./constants.js";
import {
  CacheableNormalizedProvenanceResultSchema,
  CacheSourceSchema,
  NormalizedProvenanceResultSchema,
  Sha256Schema,
  SupportedMediaMimeSchema,
  VerificationPolicyVersionSchema,
} from "./schemas.js";

export const INTEGRATION_CONTRACT_VERSION = 1 as const;
// This is the conservative integrated Check policy, not the standalone image limit.
export const MAX_INTEGRATION_CHECK_BYTES = MAX_AUDIO_BYTES;
// Current DigiBot trim-helper compatibility; this is not an audio-duration cap.
const MAX_SEGMENT_COORDINATE_SECONDS = 24 * 60 * 60;

const opaqueIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9._:-]+$/u);
const positiveDecimalIdSchema = z.string().regex(/^[1-9][0-9]{0,31}$/u);
const safePositiveDecimalIdSchema = positiveDecimalIdSchema.refine(
  (value) => Number.isSafeInteger(Number(value)),
  "Expected a positive safe-integer identifier string.",
);
const nullableErrorSchema = z
  .object({
    code: z.string().trim().min(1).max(128),
    message: z.string().trim().min(1).max(1_000),
    retryable: z.boolean(),
  })
  .strict()
  .nullable();

const segmentSchema = z
  .object({
    startSeconds: z
      .number()
      .int()
      .safe()
      .nonnegative()
      .max(MAX_SEGMENT_COORDINATE_SECONDS),
    endSeconds: z
      .number()
      .int()
      .safe()
      .positive()
      .max(MAX_SEGMENT_COORDINATE_SECONDS),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.endSeconds <= value.startSeconds ||
      value.endSeconds - value.startSeconds > MAX_AUDIO_DURATION_SECONDS
    ) {
      context.addIssue({
        code: "custom",
        message: `The requested segment must be forward and no longer than ${MAX_AUDIO_DURATION_SECONDS} seconds.`,
      });
    }
  });

const integrationMediaSchema = z
  .object({
    mediaSha256: Sha256Schema,
    byteLength: z.number().int().positive().safe(),
    mimeType: SupportedMediaMimeSchema,
    inputKind: z.enum([
      "original",
      "telegram_photo_copy",
      "screenshot_copy",
      "derived_audio_segment",
    ]),
    audioDurationSeconds: z
      .number()
      .finite()
      .positive()
      .nullable()
      .default(null),
    segment: segmentSchema.nullable().default(null),
    fullSourceSha256: Sha256Schema.nullable().default(null),
  })
  .strict()
  .superRefine((value, context) => {
    const audio = value.mimeType.startsWith("audio/");
    const derived = value.inputKind === "derived_audio_segment";
    const imageCopy =
      value.inputKind === "telegram_photo_copy" ||
      value.inputKind === "screenshot_copy";
    if (
      (!audio &&
        (value.audioDurationSeconds !== null ||
          value.segment !== null ||
          value.fullSourceSha256 !== null)) ||
      (derived &&
        (value.mimeType !== "audio/mpeg" || value.segment === null)) ||
      (audio && imageCopy) ||
      (!derived && (value.segment !== null || value.fullSourceSha256 !== null))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Media metadata must match the original or derived MP3 input kind.",
      });
    }
  });

/** Strictly parsed public input; account and result context are server-owned. */
export const IntegrationOperationInputV1Schema = z
  .object({
    version: z.literal(INTEGRATION_CONTRACT_VERSION),
    operationId: z.string().uuid(),
    action: z.enum(["check", "download"]),
    media: integrationMediaSchema,
    forceRecheck: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.action === "check" &&
        value.media.byteLength > MAX_INTEGRATION_CHECK_BYTES) ||
      (value.action === "download" && value.forceRecheck) ||
      (value.media.inputKind === "derived_audio_segment" &&
        value.action !== "check") ||
      (value.action === "check" &&
        value.media.mimeType.startsWith("audio/") &&
        (value.media.audioDurationSeconds === null ||
          value.media.audioDurationSeconds > MAX_AUDIO_DURATION_SECONDS))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "The requested action is incompatible with its size, recheck, or derived-media fields.",
      });
    }
  });
export type IntegrationOperationInputV1 = z.infer<
  typeof IntegrationOperationInputV1Schema
>;

const integrationResultSchema = z
  .object({
    resultRef: opaqueIdSchema,
    accountId: opaqueIdSchema,
    mediaSha256: Sha256Schema,
    verificationPolicyVersion: VerificationPolicyVersionSchema,
    resultSchemaVersion: z.number().int().positive(),
    originallyCheckedAt: z.iso.datetime({ offset: true }),
    cacheSource: CacheSourceSchema,
    evidence: NormalizedProvenanceResultSchema,
  })
  .strict();

// The enclosing account and media scope this receipt. Parsing does not prove
// Telegram ownership; runtime adapters must authorize and resolve it.
const archiveSchema = z
  .object({
    deliveryState: z.enum([
      "not_required",
      "pending",
      "sending",
      "confirmed",
      "failed",
      "unknown",
    ]),
    documentReceipt: z
      .object({
        botId: safePositiveDecimalIdSchema,
        chatId: safePositiveDecimalIdSchema,
        messageId: safePositiveDecimalIdSchema,
        fileId: z
          .string()
          .trim()
          .min(1)
          .max(512)
          .regex(/^[a-zA-Z0-9_-]+$/u),
      })
      .strict()
      .nullable(),
    integrityState: z.enum(["not_checked", "verified", "mismatch", "failed"]),
    roundTripSha256: Sha256Schema.nullable(),
    error: nullableErrorSchema,
    retryReady: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const confirmed = value.deliveryState === "confirmed";
    const hasRoundTripHash =
      value.integrityState === "verified" ||
      value.integrityState === "mismatch";
    const errored =
      value.deliveryState === "failed" ||
      value.deliveryState === "unknown" ||
      value.integrityState === "failed" ||
      value.integrityState === "mismatch";
    if (
      confirmed !== (value.documentReceipt !== null) ||
      hasRoundTripHash !== (value.roundTripSha256 !== null) ||
      errored !== (value.error !== null) ||
      (value.integrityState !== "not_checked" && !confirmed) ||
      (value.retryReady &&
        (value.deliveryState !== "failed" || !value.error?.retryable)) ||
      (value.deliveryState === "unknown" &&
        (value.retryReady || value.error?.retryable)) ||
      (value.deliveryState === "not_required" &&
        (value.integrityState !== "not_checked" || value.retryReady))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Archive receipt, integrity, error, and retry states must agree.",
      });
    }
  });

const historySyncSchema = z
  .object({
    state: z.enum(["pending", "synced", "failed"]),
    historyId: z.string().uuid().nullable(),
    error: nullableErrorSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.state === "synced") !== (value.historyId !== null) ||
      (value.state === "failed") !== (value.error !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "History identity and error state must match synchronization.",
      });
    }
  });

/** Trusted server snapshot. Structural validity is not authentication or ownership proof. */
export const IntegrationEnvelopeV1Schema =
  IntegrationOperationInputV1Schema.safeExtend({
    accountId: opaqueIdSchema,
    requestedAt: z.iso.datetime({ offset: true }),
    result: integrationResultSchema.nullable(),
    archive: archiveSchema,
    historySync: historySyncSchema,
  }).superRefine((value, context) => {
    const check = value.action === "check";
    const audio = value.media.mimeType.startsWith("audio/");
    if (check !== (value.result !== null)) {
      context.addIssue({
        code: "custom",
        message: "Only Check operations carry verification evidence.",
        path: ["result"],
      });
    }
    if (
      (check && !audio && value.archive.deliveryState === "not_required") ||
      (check && audio && value.archive.deliveryState !== "not_required") ||
      (!check && value.archive.deliveryState === "not_required")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Image Checks and Downloads require archiving; audio Checks do not archive automatically.",
        path: ["archive"],
      });
    }
    if (
      value.archive.integrityState === "verified" &&
      (value.archive.deliveryState !== "confirmed" ||
        value.archive.documentReceipt === null ||
        value.archive.roundTripSha256 !== value.media.mediaSha256)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A verified saved original requires a confirmed document receipt and matching round-trip hash.",
        path: ["archive", "integrityState"],
      });
    }
    if (
      value.archive.integrityState === "mismatch" &&
      value.archive.roundTripSha256 === value.media.mediaSha256
    ) {
      context.addIssue({
        code: "custom",
        message: "A mismatched archive cannot have the input media digest.",
        path: ["archive", "roundTripSha256"],
      });
    }
    if (value.result !== null) {
      if (
        value.result.accountId !== value.accountId ||
        value.result.mediaSha256 !== value.media.mediaSha256
      ) {
        context.addIssue({
          code: "custom",
          message:
            "The result reference must be associated with the envelope account and media.",
          path: ["result"],
        });
      }
      if (value.forceRecheck && value.result.cacheSource !== "fresh") {
        context.addIssue({
          code: "custom",
          message: "A forced recheck cannot claim a cache hit.",
          path: ["result", "cacheSource"],
        });
      }
      if (
        value.result.cacheSource !== "fresh" &&
        !CacheableNormalizedProvenanceResultSchema.safeParse(
          value.result.evidence,
        ).success
      ) {
        context.addIssue({
          code: "custom",
          message: "Cached evidence must have a cacheable verdict.",
          path: ["result", "evidence", "verdict"],
        });
      }
      if (
        value.result.originallyCheckedAt !== value.result.evidence.checkedAt
      ) {
        context.addIssue({
          code: "custom",
          message:
            "The original evidence time must remain stable across cache reuse.",
          path: ["result", "originallyCheckedAt"],
        });
      }
      if (
        value.operationId === value.result.evidence.requestId ||
        value.operationId === value.result.resultRef ||
        value.result.resultRef === value.result.evidence.requestId
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Operation, server result, and verification request identities must remain distinct.",
          path: ["result", "resultRef"],
        });
      }
    }
    if (
      value.result !== null &&
      (value.historySync.historyId === value.result.resultRef ||
        value.historySync.historyId === value.result.evidence.requestId)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "History identity must not reuse a result or verification request identity.",
        path: ["historySync", "historyId"],
      });
    }
  });
export type IntegrationEnvelopeV1 = z.infer<typeof IntegrationEnvelopeV1Schema>;

/**
 * Compares parsed immutable inputs only. A match does not authorize delivery retry.
 */
export function isCompatibleIntegrationReplay(
  existing: IntegrationEnvelopeV1,
  accountId: string,
  candidate: IntegrationOperationInputV1,
): boolean {
  return (
    existing.accountId === accountId &&
    existing.operationId === candidate.operationId &&
    existing.action === candidate.action &&
    existing.forceRecheck === candidate.forceRecheck &&
    existing.media.mediaSha256 === candidate.media.mediaSha256 &&
    existing.media.byteLength === candidate.media.byteLength &&
    existing.media.mimeType === candidate.media.mimeType &&
    existing.media.inputKind === candidate.media.inputKind &&
    existing.media.audioDurationSeconds ===
      candidate.media.audioDurationSeconds &&
    existing.media.fullSourceSha256 === candidate.media.fullSourceSha256 &&
    existing.media.segment?.startSeconds ===
      candidate.media.segment?.startSeconds &&
    existing.media.segment?.endSeconds === candidate.media.segment?.endSeconds
  );
}
