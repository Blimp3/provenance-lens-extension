import { z } from "zod";

import {
  IntegrationEnvelopeV1Schema,
  IntegrationOperationInputV1Schema,
} from "./integration-contracts.js";
import { Sha256Schema } from "./schemas.js";

const isoDateTime = z.iso.datetime({ offset: true });
const opaqueId = z.string().trim().min(1).max(256);
const bearerSecret = z.string().trim().min(1).max(4_096);

export const INTEGRATION_API_VERSION = 1 as const;
export const INTEGRATION_OPERATION_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const INTEGRATION_DOWNLOAD_MAX_BYTES = 49_000_000;

export const IntegrationPeriodSchema = z.enum(["24h", "7d", "30d", "all"]);
export type IntegrationPeriod = z.infer<typeof IntegrationPeriodSchema>;

export const IntegrationPairingRequestSchema = z
  .object({
    verifier: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/u, "Expected a 32-byte base64url verifier."),
    deviceName: z.string().trim().min(1).max(128),
  })
  .strict();
export type IntegrationPairingRequest = z.infer<
  typeof IntegrationPairingRequestSchema
>;

export const IntegrationPairingResponseSchema = z
  .object({
    pairId: opaqueId,
    confirmationCode: z.string().trim().min(1).max(32),
    expiresAt: isoDateTime,
  })
  .strict();
export type IntegrationPairingResponse = z.infer<
  typeof IntegrationPairingResponseSchema
>;

export const IntegrationPairingExchangeRequestSchema = z
  .object({ verifier: IntegrationPairingRequestSchema.shape.verifier })
  .strict();
export type IntegrationPairingExchangeRequest = z.infer<
  typeof IntegrationPairingExchangeRequestSchema
>;

export const IntegrationSessionResponseSchema = z
  .object({
    tokenType: z.literal("Bearer"),
    accountId: opaqueId,
    sessionId: opaqueId,
    accessToken: bearerSecret,
    accessExpiresAt: isoDateTime,
    refreshToken: bearerSecret,
    refreshExpiresAt: isoDateTime,
    absoluteExpiresAt: isoDateTime,
  })
  .strict();
export type IntegrationSessionResponse = z.infer<
  typeof IntegrationSessionResponseSchema
>;

export const IntegrationRefreshRequestSchema = z
  .object({ refreshToken: bearerSecret })
  .strict();
export type IntegrationRefreshRequest = z.infer<
  typeof IntegrationRefreshRequestSchema
>;

export const IntegrationSegmentSchema = z
  .object({
    startSeconds: z
      .number()
      .int()
      .safe()
      .nonnegative()
      .max(24 * 60 * 60),
    endSeconds: z
      .number()
      .int()
      .safe()
      .positive()
      .max(24 * 60 * 60),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endSeconds <= value.startSeconds) {
      context.addIssue({
        code: "custom",
        message: "The segment must end after it starts.",
      });
    }
    if (value.endSeconds - value.startSeconds > 60) {
      context.addIssue({
        code: "custom",
        message: "The segment may not exceed 60 seconds.",
      });
    }
  });
export type IntegrationSegment = z.infer<typeof IntegrationSegmentSchema>;

export const IntegrationOperationStateSchema = z.enum([
  "awaiting_upload",
  "queued",
  "processing",
  "completed",
  "failed",
]);
export type IntegrationOperationState = z.infer<
  typeof IntegrationOperationStateSchema
>;

export const IntegrationApiErrorSchema = z
  .object({
    code: z.string().trim().min(1).max(128),
    message: z.string().trim().min(1).max(1_000),
    retryable: z.boolean().default(false),
  })
  .strict();
export type IntegrationApiError = z.infer<typeof IntegrationApiErrorSchema>;

export const IntegrationOperationStatusSchema = z
  .object({
    version: z.literal(INTEGRATION_API_VERSION),
    operationId: z.string().uuid(),
    accountId: opaqueId,
    action: z.enum(["check", "download"]),
    state: IntegrationOperationStateSchema,
    requestedAt: isoDateTime,
    expiresAt: isoDateTime,
    mediaSha256: Sha256Schema.nullable(),
    segment: IntegrationSegmentSchema.nullable(),
    envelope: IntegrationEnvelopeV1Schema.nullable(),
    archive: IntegrationEnvelopeV1Schema.shape.archive,
    error: IntegrationApiErrorSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const completed = value.state === "completed";
    const failed = value.state === "failed";
    if (completed && value.envelope === null) {
      context.addIssue({
        code: "custom",
        message: "A completed operation must include its envelope.",
        path: ["envelope"],
      });
    }
    if (failed && value.error === null) {
      context.addIssue({
        code: "custom",
        message: "A failed operation must include an error.",
        path: ["error"],
      });
    }
    if (!failed && value.error !== null) {
      context.addIssue({
        code: "custom",
        message: "Only a failed operation may include an error.",
        path: ["error"],
      });
    }
    if (
      value.envelope !== null &&
      (value.envelope.operationId !== value.operationId ||
        value.envelope.accountId !== value.accountId ||
        value.envelope.action !== value.action)
    ) {
      context.addIssue({
        code: "custom",
        message: "The operation envelope must match its status identity.",
        path: ["envelope"],
      });
    }
    if (
      value.envelope !== null &&
      value.mediaSha256 !== value.envelope.media.mediaSha256
    ) {
      context.addIssue({
        code: "custom",
        message: "The operation media digest must match its envelope.",
        path: ["mediaSha256"],
      });
    }
    if (value.action === "download" && value.segment !== null) {
      context.addIssue({
        code: "custom",
        message: "Downloads cannot carry an audio segment.",
        path: ["segment"],
      });
    }
  });
export type IntegrationOperationStatus = z.infer<
  typeof IntegrationOperationStatusSchema
>;

export const IntegrationHistoryResponseSchema = z
  .object({
    operations: z.array(IntegrationOperationStatusSchema).max(1_000),
    nextCursor: z.string().trim().min(1).max(512).nullable(),
  })
  .strict();
export type IntegrationHistoryResponse = z.infer<
  typeof IntegrationHistoryResponseSchema
>;

export const IntegrationStatsSchema = z
  .object({
    period: IntegrationPeriodSchema,
    since: isoDateTime.nullable(),
    asOf: isoDateTime,
    checksRequested: z.number().int().nonnegative().safe(),
    checksCompleted: z.number().int().nonnegative().safe(),
    checksFailed: z.number().int().nonnegative().safe(),
    freshChecks: z.number().int().nonnegative().safe(),
    cachedChecks: z.number().int().nonnegative().safe(),
    downloadsRequested: z.number().int().nonnegative().safe(),
    downloadsConfirmed: z.number().int().nonnegative().safe(),
    downloadsFailed: z.number().int().nonnegative().safe(),
    uniqueMedia: z.number().int().nonnegative().safe(),
    savedOriginals: z.number().int().nonnegative().safe(),
    unresolvedArchives: z.number().int().nonnegative().safe(),
    legacyDownloads: z.number().int().nonnegative().safe(),
  })
  .strict();
export type IntegrationStats = z.infer<typeof IntegrationStatsSchema>;

export const IntegrationOperationInputForApiSchema =
  IntegrationOperationInputV1Schema;

export const IntegrationDeleteResponseSchema = z
  .object({ ok: z.literal(true) })
  .strict();

export const IntegrationCacheDeleteResponseSchema =
  IntegrationDeleteResponseSchema;
