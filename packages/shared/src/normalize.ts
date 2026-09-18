import {
  AUDIO_NO_SIGNAL_CACHE_WORDING,
  AUDIO_NO_SIGNAL_LIMITATION,
  INVALID_C2PA_WARNING,
  NO_SIGNAL_CACHE_WORDING,
  NO_SIGNAL_LIMITATION,
} from "./constants.js";
import {
  NormalizedProvenanceResultSchema,
  OpenAIContentProvenanceResponseSchema,
  type NormalizedProvenanceResult,
  type NormalizedSignal,
} from "./schemas.js";

export class InvalidOpenAIResponseError extends Error {
  public constructor() {
    super("The OpenAI Content Provenance API returned an invalid response.");
    this.name = "InvalidOpenAIResponseError";
  }
}

export function normalizeOpenAIResponse(
  input: unknown,
  requestId: string,
  checkedAt = new Date(),
  mediaKind: "image" | "audio" = "image",
): NormalizedProvenanceResult {
  const parsed = OpenAIContentProvenanceResponseSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidOpenAIResponseError();
  }
  if (
    mediaKind === "audio" &&
    parsed.data.results.some((entry) => entry.type === "c2pa")
  ) {
    throw new InvalidOpenAIResponseError();
  }

  const warnings: string[] = [];
  let hasReliableDetection = false;
  let hasUnreliableDetectedC2pa = false;

  const signals: NormalizedSignal[] = parsed.data.results.map((entry) => {
    if (entry.type === "c2pa") {
      if (entry.validation_state === "invalid") {
        warnings.push(INVALID_C2PA_WARNING);
      }
      if (entry.outcome === "detected") {
        if (["trusted", "valid"].includes(entry.validation_state)) {
          hasReliableDetection = true;
        } else {
          hasUnreliableDetectedC2pa = true;
        }
      }

      return {
        type: "c2pa",
        outcome: entry.outcome,
        validationState: entry.validation_state,
        issuer: entry.issuer,
        model: entry.model,
        generatedAt: entry.generated_at,
      };
    }

    if (entry.outcome === "detected") hasReliableDetection = true;
    return {
      type: "synthid",
      outcome: entry.outcome,
      validationState: null,
      issuer: null,
      model: entry.model,
      generatedAt: entry.generated_at,
    };
  });

  if (hasReliableDetection) {
    const detected = signals
      .filter(
        (signal) =>
          signal.outcome === "detected" &&
          (signal.type === "synthid" ||
            signal.validationState === "trusted" ||
            signal.validationState === "valid"),
      )
      .map((signal) => (signal.type === "c2pa" ? "C2PA" : "SynthID"));
    return NormalizedProvenanceResultSchema.parse({
      verdict: "openai_signal_detected",
      summary: `Detected signals: ${detected.join(" and ")}.`,
      signals,
      warnings,
      checkedAt: checkedAt.toISOString(),
      requestId,
    });
  }

  if (hasUnreliableDetectedC2pa) {
    return NormalizedProvenanceResultSchema.parse({
      verdict: "indeterminate",
      summary:
        "The response contained a C2PA detection without a trusted or valid manifest and could not provide reliable provenance evidence.",
      signals,
      warnings,
      checkedAt: checkedAt.toISOString(),
      requestId,
    });
  }

  return NormalizedProvenanceResultSchema.parse({
    verdict: "no_supported_openai_signal",
    summary:
      mediaKind === "audio"
        ? AUDIO_NO_SIGNAL_CACHE_WORDING
        : NO_SIGNAL_CACHE_WORDING,
    signals,
    warnings: [
      ...warnings,
      mediaKind === "audio" ? AUDIO_NO_SIGNAL_LIMITATION : NO_SIGNAL_LIMITATION,
    ],
    checkedAt: checkedAt.toISOString(),
    requestId,
  });
}

export function makeIndeterminateResult(
  summary: string,
  requestId: string = crypto.randomUUID(),
  checkedAt = new Date(),
  warnings: string[] = [],
): NormalizedProvenanceResult {
  const sanitizedSummary = sanitizeDisplayText(summary, 1_000);
  return NormalizedProvenanceResultSchema.parse({
    verdict: "indeterminate",
    summary: sanitizedSummary || "The image could not be verified.",
    signals: [],
    warnings: warnings
      .map((warning) => sanitizeDisplayText(warning, 1_000))
      .filter((warning) => warning.length > 0),
    checkedAt: checkedAt.toISOString(),
    requestId,
  });
}

export function sanitizeDisplayText(value: string, maxLength = 256): string {
  const withoutControls = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
      ? " "
      : character;
  }).join("");

  return withoutControls
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}
