import { describe, expect, it } from "vitest";

import {
  disclosureModesMatch,
  hasSynthIdAcknowledgement,
  hasVerificationModeAcknowledgement,
  isExpectedVerificationMode,
  SYNTHID_DISCLOSURE_VERSION,
} from "../../src/disclosure-policy.js";

describe("disclosure mode binding", () => {
  it("allows resumption only when all three modes match", () => {
    expect(disclosureModesMatch("website", "website", "website")).toBe(true);
    expect(disclosureModesMatch("api", "api", "api")).toBe(true);
    expect(disclosureModesMatch("synthid", "synthid", "synthid")).toBe(true);
  });

  it.each([
    ["website", "api", "website"],
    ["website", "website", "api"],
    ["api", "website", "api"],
    ["api", "api", "website"],
    ["synthid", "website", "synthid"],
    ["website", "synthid", "website"],
  ] as const)(
    "rejects a mode mismatch for pending=%s, acknowledged=%s, current=%s",
    (pendingMode, acknowledgedMode, currentMode) => {
      expect(
        disclosureModesMatch(pendingMode, acknowledgedMode, currentMode),
      ).toBe(false);
    },
  );

  it("rejects final execution after the checked mode changes", () => {
    expect(isExpectedVerificationMode("website", "website")).toBe(true);
    expect(isExpectedVerificationMode("website", "api")).toBe(false);
    expect(isExpectedVerificationMode(undefined, "api")).toBe(true);
  });

  it("requires the current mode to be acknowledged", () => {
    expect(hasVerificationModeAcknowledgement(["website"], "website")).toBe(
      true,
    );
    expect(hasVerificationModeAcknowledgement(["website"], "api")).toBe(false);
  });

  it("asks for the SynthID handoff's acknowledgement only once", () => {
    expect(hasSynthIdAcknowledgement(null)).toBe(false);
    expect(hasSynthIdAcknowledgement(undefined)).toBe(false);
    expect(hasSynthIdAcknowledgement("1")).toBe(false);
    expect(hasSynthIdAcknowledgement(SYNTHID_DISCLOSURE_VERSION - 1)).toBe(
      false,
    );
    expect(hasSynthIdAcknowledgement(SYNTHID_DISCLOSURE_VERSION)).toBe(true);
  });
});
