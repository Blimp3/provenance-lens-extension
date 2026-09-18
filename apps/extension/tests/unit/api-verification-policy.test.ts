import { describe, expect, it } from "vitest";

import { DISCLOSURE_VERSION } from "@provenance-lens/shared";

import { isApiVerificationAuthorized } from "../../src/api-verification-policy.js";

describe("direct API verification policy", () => {
  it("permits only current, acknowledged API mode", () => {
    expect(
      isApiVerificationAuthorized({
        verificationMode: "api",
        acknowledgedVerificationModes: ["api"],
        disclosureVersion: DISCLOSURE_VERSION,
      }),
    ).toBe(true);
  });

  it.each([
    {
      verificationMode: "website" as const,
      acknowledgedVerificationModes: ["api"] as const,
      disclosureVersion: DISCLOSURE_VERSION,
    },
    {
      verificationMode: "api" as const,
      acknowledgedVerificationModes: [] as const,
      disclosureVersion: DISCLOSURE_VERSION,
    },
    {
      verificationMode: "api" as const,
      acknowledgedVerificationModes: ["api"] as const,
      disclosureVersion: DISCLOSURE_VERSION - 1,
    },
  ])(
    "rejects Website, unacknowledged, or stale-disclosure state",
    (settings) => {
      expect(isApiVerificationAuthorized(settings)).toBe(false);
    },
  );
});
