import type { VerificationMode } from "@provenance-lens/shared";

/**
 * A disclosure acknowledgement is valid only when it describes the mode that
 * was captured when the request started, the mode shown to the user, and the
 * mode currently configured in Settings.
 */
export function disclosureModesMatch(
  pendingMode: VerificationMode,
  acknowledgedMode: VerificationMode,
  currentMode: VerificationMode,
): boolean {
  return pendingMode === acknowledgedMode && acknowledgedMode === currentMode;
}

export function isExpectedVerificationMode(
  expectedMode: VerificationMode | undefined,
  currentMode: VerificationMode,
): boolean {
  return expectedMode === undefined || expectedMode === currentMode;
}

export function hasVerificationModeAcknowledgement(
  acknowledgedModes: readonly VerificationMode[],
  currentMode: VerificationMode,
): boolean {
  return acknowledgedModes.includes(currentMode);
}
