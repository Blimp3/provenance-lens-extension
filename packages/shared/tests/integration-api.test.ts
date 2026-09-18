import { readFileSync } from "node:fs";

import {
  IntegrationEnvelopeV1Schema,
  IntegrationHistoryResponseSchema,
  IntegrationOperationStatusSchema,
  IntegrationPairingRequestSchema,
  IntegrationSessionResponseSchema,
  IntegrationStatsSchema,
} from "../src/index.js";

const fixture = IntegrationEnvelopeV1Schema.parse(
  JSON.parse(
    readFileSync(
      new URL("./fixtures/integration-envelope-v1.json", import.meta.url),
      "utf8",
    ),
  ),
);

describe("integration API DTOs", () => {
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
