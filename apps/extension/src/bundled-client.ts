import {
  DEFAULT_BACKEND_URL,
  parseBackendBaseUrl,
  type ExtensionSettings,
} from "@provenance-lens/shared";

declare const __PROVENANCE_LENS_BUNDLED_CLIENT_TOKEN__: string;

export const BUNDLED_CLIENT_TOKEN =
  typeof __PROVENANCE_LENS_BUNDLED_CLIENT_TOKEN__ === "string"
    ? __PROVENANCE_LENS_BUNDLED_CLIENT_TOKEN__
    : "";

export function isDefaultBackendUrl(value: string): boolean {
  try {
    return (
      parseBackendBaseUrl(value).toString().replace(/\/$/u, "") ===
      DEFAULT_BACKEND_URL
    );
  } catch {
    return false;
  }
}

export function getBundledClientTokenForBackend(
  backendBaseUrl: string,
  bundledToken = BUNDLED_CLIENT_TOKEN,
): string {
  return bundledToken && isDefaultBackendUrl(backendBaseUrl)
    ? bundledToken
    : "";
}

export function applyBundledClientToken(
  settings: ExtensionSettings,
  bundledToken = BUNDLED_CLIENT_TOKEN,
): ExtensionSettings {
  const token = getBundledClientTokenForBackend(
    settings.backendBaseUrl,
    bundledToken,
  );
  if (!token || settings.clientToken === token) return settings;
  return { ...settings, clientToken: token };
}
