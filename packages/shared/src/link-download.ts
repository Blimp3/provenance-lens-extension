import { z } from "zod";

// This module depends on zod alone, so the extension message schemas can
// embed the options without a cycle through the integration API module.

/** DigiBot's trim ceiling: a clip is one trim of the download, not a segment check. */
const MAX_LINK_CLIP_SECONDS = 24 * 60 * 60;
const linkClipSecondsSchema = z
  .number()
  .int()
  .safe()
  .nonnegative()
  .max(MAX_LINK_CLIP_SECONDS);

/**
 * What a page link may ask of DigiBot besides the default video: an MP3, a
 * clip, or both. Only present keys are sent, so a Video request stays
 * {operationId, sourceUrl}; DigiBot refuses any other output or a one-sided,
 * empty or over-long clip with a 400.
 */
export const LinkDownloadOptionsSchema = z
  .object({
    output: z.literal("mp3").optional(),
    startSeconds: linkClipSecondsSchema.optional(),
    endSeconds: linkClipSecondsSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasStart = value.startSeconds !== undefined;
    const hasEnd = value.endSeconds !== undefined;
    if (hasStart !== hasEnd) {
      context.addIssue({
        code: "custom",
        message: "A clip needs both a start and an end.",
        path: [hasStart ? "endSeconds" : "startSeconds"],
      });
    } else if (
      value.startSeconds !== undefined &&
      value.endSeconds !== undefined &&
      value.endSeconds <= value.startSeconds
    ) {
      context.addIssue({
        code: "custom",
        message: "The clip must start before it ends.",
        path: ["endSeconds"],
      });
    }
  });
export type LinkDownloadOptions = z.infer<typeof LinkDownloadOptionsSchema>;
