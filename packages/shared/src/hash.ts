import type { Sha256 } from "./schemas.js";

export async function sha256Hex(bytes: Uint8Array): Promise<Sha256> {
  const exactBytes = Uint8Array.from(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", exactBytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function deriveCacheNamespace(
  backendOrigin: string,
  clientIdentity: string,
): Promise<Sha256> {
  const encoded = new TextEncoder().encode(
    `provenance-lens-cache\u0000${backendOrigin}\u0000${clientIdentity}`,
  );
  return sha256Hex(encoded);
}
