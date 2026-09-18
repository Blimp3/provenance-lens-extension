import { readFileSync } from "node:fs";

import {
  IntegrationEnvelopeV1Schema,
  IntegrationOperationInputV1Schema,
  MAX_INTEGRATION_CHECK_BYTES,
  isCompatibleIntegrationReplay,
  type IntegrationEnvelopeV1,
  type IntegrationOperationInputV1,
} from "../src/index.js";

const fixtureJson = JSON.parse(
  readFileSync(
    new URL("./fixtures/integration-envelope-v1.json", import.meta.url),
    "utf8",
  ),
) as unknown;
const fixture = IntegrationEnvelopeV1Schema.parse(fixtureJson);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function publicInput(
  envelope: IntegrationEnvelopeV1 = fixture,
): IntegrationOperationInputV1 {
  return IntegrationOperationInputV1Schema.parse({
    version: envelope.version,
    operationId: envelope.operationId,
    action: envelope.action,
    media: envelope.media,
    forceRecheck: envelope.forceRecheck,
  });
}

function audioEnvelope(): IntegrationEnvelopeV1 {
  const value = clone(fixture);
  value.media = {
    mediaSha256: "b".repeat(64),
    byteLength: 1_024,
    mimeType: "audio/mpeg",
    inputKind: "derived_audio_segment",
    audioDurationSeconds: 30,
    segment: { startSeconds: 5, endSeconds: 35 },
    fullSourceSha256: "c".repeat(64),
  };
  if (value.result === null) throw new Error("Fixture result is required.");
  value.result.mediaSha256 = value.media.mediaSha256;
  value.result.verificationPolicyVersion = "openai-content-provenance-v1";
  value.result.resultSchemaVersion = 1;
  value.result.evidence = {
    verdict: "no_supported_openai_signal",
    summary: "No supported audio provenance signal was detected.",
    signals: [
      {
        type: "synthid",
        outcome: "not_detected",
        validationState: null,
        issuer: null,
        model: null,
        generatedAt: null,
      },
    ],
    warnings: [],
    checkedAt: value.result.originallyCheckedAt,
    requestId: "44444444-4444-4444-8444-444444444444",
  };
  value.archive = {
    deliveryState: "not_required",
    documentReceipt: null,
    integrityState: "not_checked",
    roundTripSha256: null,
    error: null,
    retryReady: false,
  };
  value.historySync = { state: "pending", historyId: null, error: null };
  return IntegrationEnvelopeV1Schema.parse(value);
}

describe("integration contract v1", () => {
  it("parses the representative server envelope and keeps public input strict", () => {
    expect(fixture.version).toBe(1);
    expect(fixture.result?.evidence.requestId).not.toBe(fixture.operationId);
    expect(
      IntegrationOperationInputV1Schema.safeParse(fixtureJson).success,
    ).toBe(false);
    expect(publicInput()).not.toHaveProperty("accountId");
  });

  it("admits exactly 4 MiB for image/audio Check and rejects one byte more", () => {
    for (const exact of [publicInput(), publicInput(audioEnvelope())]) {
      exact.media.byteLength = MAX_INTEGRATION_CHECK_BYTES;
      expect(IntegrationOperationInputV1Schema.safeParse(exact).success).toBe(
        true,
      );

      exact.media.byteLength += 1;
      expect(IntegrationOperationInputV1Schema.safeParse(exact).success).toBe(
        false,
      );
    }
  });

  it("admits 60-second audio and rejects longer, equal, or reversed ranges", () => {
    const audio = audioEnvelope();
    audio.media.audioDurationSeconds = 60;
    audio.media.segment = { startSeconds: 4, endSeconds: 64 };
    expect(IntegrationEnvelopeV1Schema.safeParse(audio).success).toBe(true);

    audio.media.segment.endSeconds = 65;
    expect(IntegrationEnvelopeV1Schema.safeParse(audio).success).toBe(false);
    audio.media.segment.endSeconds = 64;

    audio.media.audioDurationSeconds = 60.001;
    expect(IntegrationEnvelopeV1Schema.safeParse(audio).success).toBe(false);

    audio.media.audioDurationSeconds = 30;
    audio.media.segment = { startSeconds: 5, endSeconds: 5 };
    expect(IntegrationEnvelopeV1Schema.safeParse(audio).success).toBe(false);

    audio.media.segment = { startSeconds: 6, endSeconds: 5 };
    expect(IntegrationEnvelopeV1Schema.safeParse(audio).success).toBe(false);

    audio.media.segment = { startSeconds: 5, endSeconds: 35 };
    audio.media.audioDurationSeconds = null;
    expect(IntegrationEnvelopeV1Schema.safeParse(audio).success).toBe(false);

    audio.media.audioDurationSeconds = 30;
    audio.media.segment = { startSeconds: 5.5, endSeconds: 35 };
    expect(IntegrationEnvelopeV1Schema.safeParse(audio).success).toBe(false);

    audio.media.segment = { startSeconds: 86_341, endSeconds: 86_401 };
    expect(IntegrationEnvelopeV1Schema.safeParse(audio).success).toBe(false);
  });

  it("does not apply the Check duration ceiling to original-audio Download", () => {
    const download = clone(fixture);
    download.action = "download";
    download.media = {
      mediaSha256: "b".repeat(64),
      byteLength: 1_024,
      mimeType: "audio/mpeg",
      inputKind: "original",
      audioDurationSeconds: 600,
      segment: null,
      fullSourceSha256: null,
    };
    download.result = null;
    download.archive.roundTripSha256 = download.media.mediaSha256;
    expect(IntegrationEnvelopeV1Schema.safeParse(download).success).toBe(true);
  });

  it("distinguishes image originals from Telegram and screenshot copies", () => {
    for (const inputKind of [
      "original",
      "telegram_photo_copy",
      "screenshot_copy",
    ] as const) {
      const image = publicInput();
      image.media.inputKind = inputKind;
      expect(
        IntegrationOperationInputV1Schema.safeParse(image).success,
        inputKind,
      ).toBe(true);
    }

    const audio = publicInput(audioEnvelope());
    audio.media.inputKind = "telegram_photo_copy";
    expect(IntegrationOperationInputV1Schema.safeParse(audio).success).toBe(
      false,
    );
  });

  it("keeps Download free of check evidence", () => {
    const download = clone(fixture);
    download.action = "download";
    download.result = null;
    expect(IntegrationEnvelopeV1Schema.safeParse(download).success).toBe(true);

    download.result = fixture.result;
    expect(IntegrationEnvelopeV1Schema.safeParse(download).success).toBe(false);
  });

  it("requires image Check archiving even for a cached result", () => {
    const cached = clone(fixture);
    if (cached.result === null) throw new Error("Fixture result is required.");
    cached.requestedAt = "2026-09-16T11:00:00.000Z";
    cached.result.cacheSource = "local_cache";
    cached.archive = {
      deliveryState: "pending",
      documentReceipt: null,
      integrityState: "not_checked",
      roundTripSha256: null,
      error: null,
      retryReady: false,
    };
    cached.historySync = { state: "pending", historyId: null, error: null };
    expect(IntegrationEnvelopeV1Schema.safeParse(cached).success).toBe(true);

    cached.archive.deliveryState = "not_required";
    expect(IntegrationEnvelopeV1Schema.safeParse(cached).success).toBe(false);
  });

  it("allows completed evidence with archive or History failure", () => {
    const value = clone(fixture);
    value.archive = {
      deliveryState: "failed",
      documentReceipt: null,
      integrityState: "not_checked",
      roundTripSha256: null,
      error: {
        code: "telegram_send_failed",
        message: "Telegram rejected the document send.",
        retryable: true,
      },
      retryReady: true,
    };
    value.historySync = {
      state: "failed",
      historyId: null,
      error: {
        code: "history_unavailable",
        message: "History storage was unavailable.",
        retryable: true,
      },
    };
    expect(IntegrationEnvelopeV1Schema.safeParse(value).success).toBe(true);
  });

  it("blocks blind retry after an unknown document send", () => {
    const value = clone(fixture);
    value.archive = {
      deliveryState: "unknown",
      documentReceipt: null,
      integrityState: "not_checked",
      roundTripSha256: null,
      error: {
        code: "telegram_send_unknown",
        message: "The send outcome is unknown and requires reconciliation.",
        retryable: false,
      },
      retryReady: false,
    };
    expect(IntegrationEnvelopeV1Schema.safeParse(value).success).toBe(true);

    value.archive.retryReady = true;
    expect(IntegrationEnvelopeV1Schema.safeParse(value).success).toBe(false);

    value.archive.retryReady = false;
    if (value.archive.error === null)
      throw new Error("Unknown delivery error is required.");
    value.archive.error.retryable = true;
    expect(IntegrationEnvelopeV1Schema.safeParse(value).success).toBe(false);

    for (const deliveryState of ["pending", "sending"] as const) {
      const premature = clone(fixture);
      premature.archive = {
        deliveryState,
        documentReceipt: null,
        integrityState: "not_checked",
        roundTripSha256: null,
        error: null,
        retryReady: true,
      };
      expect(
        IntegrationEnvelopeV1Schema.safeParse(premature).success,
        deliveryState,
      ).toBe(false);
    }

    const confirmed = clone(fixture);
    confirmed.archive.retryReady = true;
    expect(IntegrationEnvelopeV1Schema.safeParse(confirmed).success).toBe(
      false,
    );
  });

  it("requires confirmed document bytes before claiming a verified original", () => {
    const value = clone(fixture);
    value.archive.roundTripSha256 = "b".repeat(64);
    expect(IntegrationEnvelopeV1Schema.safeParse(value).success).toBe(false);

    value.archive.roundTripSha256 = value.media.mediaSha256;
    value.archive.documentReceipt = null;
    expect(IntegrationEnvelopeV1Schema.safeParse(value).success).toBe(false);

    value.archive = {
      deliveryState: "failed",
      documentReceipt: null,
      integrityState: "failed",
      roundTripSha256: null,
      error: {
        code: "integrity_failed",
        message: "The retrieved document could not be hashed.",
        retryable: true,
      },
      retryReady: true,
    };
    expect(IntegrationEnvelopeV1Schema.safeParse(value).success).toBe(false);
  });

  it("accepts only safe positive Telegram receipt identifiers", () => {
    for (const field of ["botId", "chatId", "messageId"] as const) {
      for (const invalid of ["0", "-1", "9007199254740992"]) {
        const value = clone(fixture);
        if (value.archive.documentReceipt === null)
          throw new Error("Fixture receipt is required.");
        value.archive.documentReceipt[field] = invalid;
        expect(
          IntegrationEnvelopeV1Schema.safeParse(value).success,
          `${field}: ${invalid}`,
        ).toBe(false);
      }
    }
  });

  it("rejects cross-account and cross-media result references structurally", () => {
    const otherAccount = clone(fixture);
    if (otherAccount.result === null)
      throw new Error("Fixture result is required.");
    otherAccount.result.accountId = "another-account";
    expect(IntegrationEnvelopeV1Schema.safeParse(otherAccount).success).toBe(
      false,
    );

    const otherMedia = clone(fixture);
    if (otherMedia.result === null)
      throw new Error("Fixture result is required.");
    otherMedia.result.mediaSha256 = "b".repeat(64);
    expect(IntegrationEnvelopeV1Schema.safeParse(otherMedia).success).toBe(
      false,
    );
  });

  it("rejects a cached forced recheck", () => {
    const value = clone(fixture);
    if (value.result === null) throw new Error("Fixture result is required.");
    value.forceRecheck = true;
    value.result.cacheSource = "server_cache";
    expect(IntegrationEnvelopeV1Schema.safeParse(value).success).toBe(false);
  });

  it("rejects indeterminate evidence presented as a cache hit", () => {
    const value = clone(fixture);
    if (value.result === null) throw new Error("Fixture result is required.");
    value.result.cacheSource = "local_cache";
    value.result.evidence.verdict = "indeterminate";
    expect(IntegrationEnvelopeV1Schema.safeParse(value).success).toBe(false);
  });

  it("allows authoritative History to project the operation ID", () => {
    const value = clone(fixture);
    value.historySync.historyId = value.operationId;
    expect(IntegrationEnvelopeV1Schema.safeParse(value).success).toBe(true);
  });

  it("records derived audio processing as Check without automatic archive", () => {
    const audio = audioEnvelope();
    expect(audio.action).toBe("check");
    expect(audio.archive.deliveryState).toBe("not_required");

    const asDownload = publicInput(audio);
    asDownload.action = "download";
    expect(
      IntegrationOperationInputV1Schema.safeParse(asDownload).success,
    ).toBe(false);

    audio.archive.deliveryState = "pending";
    expect(IntegrationEnvelopeV1Schema.safeParse(audio).success).toBe(false);
  });

  it("accepts only an exact same-account replay for an operation ID", () => {
    const same = publicInput();
    expect(
      isCompatibleIntegrationReplay(fixture, fixture.accountId, same),
    ).toBe(true);

    const changes: Array<
      [string, (candidate: IntegrationOperationInputV1) => void]
    > = [
      ["action", (candidate) => (candidate.action = "download")],
      ["hash", (candidate) => (candidate.media.mediaSha256 = "b".repeat(64))],
      ["size", (candidate) => (candidate.media.byteLength += 1)],
      ["MIME", (candidate) => (candidate.media.mimeType = "image/jpeg")],
      ["recheck", (candidate) => (candidate.forceRecheck = true)],
    ];
    for (const [name, change] of changes) {
      const candidate = clone(same);
      change(candidate);
      expect(
        isCompatibleIntegrationReplay(fixture, fixture.accountId, candidate),
        name,
      ).toBe(false);
    }

    expect(
      isCompatibleIntegrationReplay(fixture, "another-account", same),
    ).toBe(false);
    same.operationId = "55555555-5555-4555-8555-555555555555";
    expect(IntegrationOperationInputV1Schema.safeParse(same).success).toBe(
      true,
    );
    expect(
      isCompatibleIntegrationReplay(fixture, fixture.accountId, same),
    ).toBe(false);
  });

  it("binds derived input kind, source hash, and requested scope on replay", () => {
    const audio = audioEnvelope();
    const same = publicInput(audio);
    expect(isCompatibleIntegrationReplay(audio, audio.accountId, same)).toBe(
      true,
    );

    const sourceChanged = clone(same);
    sourceChanged.media.fullSourceSha256 = "d".repeat(64);
    expect(
      isCompatibleIntegrationReplay(audio, audio.accountId, sourceChanged),
    ).toBe(false);

    const scopeChanged = clone(same);
    if (scopeChanged.media.segment === null)
      throw new Error("Audio segment is required.");
    scopeChanged.media.segment.startSeconds += 1;
    expect(
      isCompatibleIntegrationReplay(audio, audio.accountId, scopeChanged),
    ).toBe(false);

    const kindChanged = clone(same);
    kindChanged.media.inputKind = "original";
    expect(
      isCompatibleIntegrationReplay(audio, audio.accountId, kindChanged),
    ).toBe(false);
  });
});
