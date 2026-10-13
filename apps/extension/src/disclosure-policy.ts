import type { DisclosureMode, VerificationMode } from "@provenance-lens/shared";

/**
 * The Google SynthID handoff's one-time acknowledgement
 * (docs/design/palette-2.0.md §3.4). It is stored apart from the verification
 * modes; raise the version when the disclosure changes what it names.
 */
export const SYNTHID_DISCLOSURE_VERSION = 1;

/**
 * A disclosure acknowledgement is valid only when it describes the mode that
 * was captured when the request started, the mode shown to the user, and the
 * mode currently configured in Settings. A SynthID handoff's current mode is
 * always "synthid".
 */
export function disclosureModesMatch(
  pendingMode: DisclosureMode,
  acknowledgedMode: DisclosureMode,
  currentMode: DisclosureMode,
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

/** Whether the stored SynthID acknowledgement covers today's disclosure. */
export function hasSynthIdAcknowledgement(
  acknowledgedVersion: unknown,
): boolean {
  return (
    typeof acknowledgedVersion === "number" &&
    acknowledgedVersion >= SYNTHID_DISCLOSURE_VERSION
  );
}
