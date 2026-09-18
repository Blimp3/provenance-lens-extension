import {
  DISCLOSURE_VERSION,
  type VerificationMode,
} from "@provenance-lens/shared";

export const API_MODE_REQUIRED_MESSAGE =
  "This action uses the automatic API. Switch to API mode in Settings and acknowledge its privacy disclosure before continuing.";

/**
 * Direct API-only actions do not pass through the normal picker disclosure
 * flow, so they must independently enforce the same current-mode boundary.
 */
export function isApiVerificationAuthorized(settings: {
  verificationMode: VerificationMode;
  acknowledgedVerificationModes: readonly VerificationMode[];
  disclosureVersion: number;
}): boolean {
  return (
    settings.verificationMode === "api" &&
    settings.disclosureVersion >= DISCLOSURE_VERSION &&
    settings.acknowledgedVerificationModes.includes("api")
  );
}
