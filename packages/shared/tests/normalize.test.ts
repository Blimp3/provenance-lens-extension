import {
  INVALID_C2PA_WARNING,
  InvalidOpenAIResponseError,
  NO_SIGNAL_CACHE_WORDING,
  NO_SIGNAL_LIMITATION,
  normalizeOpenAIResponse,
} from "../src/index.js";

const requestId = "123e4567-e89b-42d3-a456-426614174000";
const checkedAt = new Date("2026-09-01T10:00:00.000Z");

const c2pa = (
  outcome: "detected" | "not_detected",
  validation = "trusted",
) => ({
  type: "c2pa",
  outcome,
  validation_state: validation,
  issuer: "OpenAI OpCo, LLC",
  model: "gpt-image",
  generated_at: "2026-08-31T10:00:00Z",
});

const synthid = (outcome: "detected" | "not_detected") => ({
  type: "synthid",
  outcome,
  model: null,
  generated_at: null,
});

function response(results: unknown[]) {
  return {
    object: "content_provenance_check",
    created_at: 1_778_000_000,
    results,
  };
}

describe("OpenAI provenance normalization", () => {
  it("normalizes C2PA detection", () => {
    const result = normalizeOpenAIResponse(
      response([c2pa("detected")]),
      requestId,
      checkedAt,
    );
    expect(result.verdict).toBe("openai_signal_detected");
    expect(result.summary).toContain("C2PA");
  });

  it("normalizes SynthID detection", () => {
    const result = normalizeOpenAIResponse(
      response([synthid("detected")]),
      requestId,
      checkedAt,
    );
    expect(result.verdict).toBe("openai_signal_detected");
    expect(result.summary).toContain("SynthID");
  });

  it("normalizes both detected signals", () => {
    const result = normalizeOpenAIResponse(
      response([c2pa("detected"), synthid("detected")]),
      requestId,
      checkedAt,
    );
    expect(result.summary).toBe("Detected signals: C2PA and SynthID.");
  });

  it("uses careful wording when neither signal is detected", () => {
    const result = normalizeOpenAIResponse(
      response([c2pa("not_detected", "not_present"), synthid("not_detected")]),
      requestId,
      checkedAt,
    );
    expect(result.verdict).toBe("no_supported_openai_signal");
    expect(result.summary).toBe(NO_SIGNAL_CACHE_WORDING);
    expect(result.warnings).toContain(NO_SIGNAL_LIMITATION);
  });

  it("does not infer OpenAI provenance from a third-party C2PA issuer", () => {
    const thirdParty = {
      ...c2pa("not_detected", "valid"),
      issuer: "Example Camera Company",
    };
    const result = normalizeOpenAIResponse(
      response([thirdParty]),
      requestId,
      checkedAt,
    );
    expect(result.verdict).toBe("no_supported_openai_signal");
    expect(result.signals[0]?.issuer).toBe("Example Camera Company");
  });

  it("treats an inconsistent invalid detected C2PA result as indeterminate", () => {
    const result = normalizeOpenAIResponse(
      response([c2pa("detected", "invalid")]),
      requestId,
      checkedAt,
    );
    expect(result.verdict).toBe("indeterminate");
    expect(result.warnings).toContain(INVALID_C2PA_WARNING);
  });

  it("treats a detected C2PA result without a manifest as indeterminate", () => {
    const result = normalizeOpenAIResponse(
      response([c2pa("detected", "not_present")]),
      requestId,
      checkedAt,
    );
    expect(result.verdict).toBe("indeterminate");
    expect(result.summary).toContain("without a trusted or valid manifest");
    expect(result.warnings).not.toContain(INVALID_C2PA_WARNING);
  });

  it("does not name an unreliable C2PA result in a mixed detection summary", () => {
    const result = normalizeOpenAIResponse(
      response([c2pa("detected", "not_present"), synthid("detected")]),
      requestId,
      checkedAt,
    );
    expect(result.verdict).toBe("openai_signal_detected");
    expect(result.summary).toBe("Detected signals: SynthID.");
  });

  it("preserves an invalid C2PA warning when SynthID is detected", () => {
    const result = normalizeOpenAIResponse(
      response([c2pa("not_detected", "invalid"), synthid("detected")]),
      requestId,
      checkedAt,
    );
    expect(result.verdict).toBe("openai_signal_detected");
    expect(result.warnings).toContain(INVALID_C2PA_WARNING);
  });

  it.each([
    response([]),
    response([{ type: "unsupported", outcome: "detected" }]),
    response([synthid("detected"), synthid("not_detected")]),
    response([{ type: "c2pa", outcome: "detected" }]),
    { object: "content_provenance_check", results: [synthid("detected")] },
    { outcome: "detected", results: [synthid("detected")] },
  ])("rejects missing fields or unsupported response shapes", (input) => {
    expect(() => normalizeOpenAIResponse(input, requestId, checkedAt)).toThrow(
      InvalidOpenAIResponseError,
    );
  });
});
