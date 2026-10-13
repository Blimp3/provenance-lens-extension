import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  IMAGE_VERIFICATION_POLICY_VERSION,
  INTEGRATION_API_VERSION,
  IntegrationDeleteResponseSchema,
  IntegrationEnvelopeV1Schema,
  IntegrationHistoryResponseSchema,
  IntegrationLinkDownloadResponseSchema,
  IntegrationOperationStatusSchema,
  IntegrationPairingRequestSchema,
  IntegrationPairingResponseSchema,
  IntegrationSessionResponseSchema,
  IntegrationStatsSchema,
  LinkDownloadOptionsSchema,
  VERIFICATION_POLICY_VERSION,
} from "../src/index.js";

const fixture = IntegrationEnvelopeV1Schema.parse(
  JSON.parse(
    readFileSync(
      new URL("./fixtures/integration-envelope-v1.json", import.meta.url),
      "utf8",
    ),
  ),
);

// A byte-for-byte copy of DigiBot's gateway contract fixture, which
// DigiBot's gateway tests compare with its live responses.
const contractSha256 =
  "5f94808930821581657b73e296b4b0d08ad8085a5246ebea2d9e6cfd8cde30b3";
const contractText = readFileSync(
  new URL("./fixtures/integration-api-v1.json", import.meta.url),
  "utf8",
);

describe("integration API DTOs", () => {
  it("parses every DigiBot gateway contract entry unchanged", () => {
    expect(createHash("sha256").update(contractText).digest("hex")).toBe(
      contractSha256,
    );
    const contract = JSON.parse(contractText) as Record<string, unknown>;
    const schemas = {
      pairing: IntegrationPairingResponseSchema,
      session: IntegrationSessionResponseSchema,
      awaitingUpload: IntegrationOperationStatusSchema,
      completedCheck: IntegrationOperationStatusSchema,
      completedDownload: IntegrationOperationStatusSchema,
      failed: IntegrationOperationStatusSchema,
      history: IntegrationHistoryResponseSchema,
      stats: IntegrationStatsSchema,
      deleteOk: IntegrationDeleteResponseSchema,
    };
    for (const [key, schema] of Object.entries(schemas)) {
      expect(schema.parse(contract[key]), key).toEqual(contract[key]);
    }
    expect(contract["version"]).toBe(INTEGRATION_API_VERSION);
    expect(contract["policyVersions"]).toEqual({
      image: IMAGE_VERIFICATION_POLICY_VERSION,
      audio: VERIFICATION_POLICY_VERSION,
    });
    // verifierRequests belongs to the excluded verification Worker's tests; the
    // linkDownload entries are {request, status, response} wrappers checked below.
    expect(Object.keys(contract).sort()).toEqual(
      [
        ...Object.keys(schemas),
        "linkDownload",
        "linkDownloadM4a",
        "linkDownloadVoice",
        "policyVersions",
        "verifierRequests",
        "version",
      ].sort(),
    );
  });

  it("matches DigiBot's recorded link-download requests and responses", () => {
    type RecordedLinkDownload = {
      request: {
        method: string;
        path: string;
        body: Record<string, unknown>;
      };
      status: number;
      response: unknown;
    };
    const contract = JSON.parse(contractText) as Record<
      "linkDownload" | "linkDownloadVoice" | "linkDownloadM4a",
      RecordedLinkDownload
    >;
    for (const [key, output] of [
      ["linkDownload", "mp3"],
      ["linkDownloadVoice", "voice"],
      ["linkDownloadM4a", "m4a"],
    ] as const) {
      const recorded = contract[key];
      expect(Object.keys(recorded).sort(), key).toEqual([
        "request",
        "response",
        "status",
      ]);
      expect(
        IntegrationLinkDownloadResponseSchema.parse(recorded.response),
      ).toEqual(recorded.response);
      expect(recorded.status).toBe(202);
      expect(recorded.request.method).toBe("POST");
      expect(recorded.request.path).toBe("/api/integration/link-downloads");
      expect(Object.keys(recorded.request.body).sort()).toEqual([
        "operationId",
        "output",
        "sourceUrl",
      ]);
      const { operationId, sourceUrl, ...options } = recorded.request.body;
      expect(typeof operationId).toBe("string");
      expect(typeof sourceUrl).toBe("string");
      expect(LinkDownloadOptionsSchema.parse(options), key).toEqual({ output });
    }
  });

  it("accepts only a queued link download job", () => {
    const queued = {
      jobId: "123e4567-e89b-42d3-a456-426614174000",
      state: "queued",
    };
    expect(IntegrationLinkDownloadResponseSchema.parse(queued)).toEqual(queued);
    for (const invalid of [
      { ...queued, state: "processing" },
      { ...queued, jobId: "job-1" },
      { ...queued, operationId: queued.jobId },
      { jobId: queued.jobId },
    ]) {
      expect(
        IntegrationLinkDownloadResponseSchema.safeParse(invalid).success,
        JSON.stringify(invalid),
      ).toBe(false);
    }
  });

  it("parses pairing and session responses without accepting account input", () => {
    expect(
      IntegrationPairingRequestSchema.safeParse({
        verifier: "A".repeat(43),
        deviceName: "Browser on laptop",
      }).success,
    ).toBe(true);
    expect(
      IntegrationPairingRequestSchema.safeParse({
        verifier: "short",
        deviceName: "Browser on laptop",
        accountId: "caller-selected-account",
      }).success,
    ).toBe(false);

    const session = IntegrationSessionResponseSchema.parse({
      tokenType: "Bearer",
      accountId: "account-fixture-1",
      sessionId: "session-fixture-1",
      accessToken: "access-token-fixture",
      accessExpiresAt: "2026-09-16T10:15:00.000Z",
      refreshToken: "refresh-token-fixture",
      refreshExpiresAt: "2026-09-23T10:00:00.000Z",
      absoluteExpiresAt: "2026-10-16T10:00:00.000Z",
    });
    expect(session.accountId).toBe("account-fixture-1");
  });

  it("keeps completed operation identity and archive independent", () => {
    const status = IntegrationOperationStatusSchema.parse({
      version: 1,
      operationId: fixture.operationId,
      accountId: fixture.accountId,
      action: fixture.action,
      state: "completed",
      requestedAt: fixture.requestedAt,
      expiresAt: "2026-09-17T10:00:00.000Z",
      mediaSha256: fixture.media.mediaSha256,
      segment: null,
      envelope: fixture,
      archive: fixture.archive,
      error: null,
    });
    expect(status.envelope?.historySync.state).toBe("synced");

    const history = IntegrationHistoryResponseSchema.parse({
      operations: [status],
      nextCursor: null,
    });
    expect(history.operations).toHaveLength(1);
  });

  it("rejects mismatched operation media and malformed statistics", () => {
    const status = {
      version: 1,
      operationId: fixture.operationId,
      accountId: fixture.accountId,
      action: fixture.action,
      state: "completed",
      requestedAt: fixture.requestedAt,
      expiresAt: "2026-09-17T10:00:00.000Z",
      mediaSha256: "b".repeat(64),
      segment: null,
      envelope: fixture,
      archive: fixture.archive,
      error: null,
    };
    expect(IntegrationOperationStatusSchema.safeParse(status).success).toBe(
      false,
    );

    expect(
      IntegrationStatsSchema.safeParse({
        period: "24h",
        since: null,
        asOf: "2026-09-16T10:00:00.000Z",
        checksRequested: 1,
        checksCompleted: 1,
        checksFailed: 0,
        freshChecks: 1,
        cachedChecks: 0,
        downloadsRequested: 0,
        downloadsConfirmed: 0,
        downloadsFailed: 0,
        uniqueMedia: 1,
        savedOriginals: 1,
        unresolvedArchives: 0,
        legacyDownloads: 0,
        unexpected: true,
      }).success,
    ).toBe(false);
  });
});
