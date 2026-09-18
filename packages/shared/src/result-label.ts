import type { MediaKind, NormalizedProvenanceResult } from "./schemas.js";

export function resultLabel(
  result: NormalizedProvenanceResult,
  mediaKind: MediaKind = "image",
): string {
  const credentials = result.contentCredentials;
  if (
    credentials?.status === "verified" &&
    credentials.aiDeclaration &&
    (credentials.signerTrusted || result.verdict !== "openai_signal_detected")
  ) {
    const declaration =
      credentials.aiDeclaration === "generated"
        ? "AI generation"
        : "AI editing";
    return `${declaration} declared${credentials.signerTrusted ? " in trusted Content Credentials" : " by an untrusted signer"}`;
  }
  if (result.verdict === "openai_signal_detected")
    return mediaKind === "audio"
      ? "OpenAI audio signal detected"
      : "OpenAI provenance detected";
  if (credentials?.status === "verified") return "Content Credentials verified";
  if (credentials?.status === "invalid")
    return "Content Credentials failed validation";
  if (result.verdict === "no_supported_openai_signal")
    return mediaKind === "audio"
      ? "No supported OpenAI audio signal detected"
      : "No supported OpenAI signal detected";
  return `The ${mediaKind} could not be verified`;
}
