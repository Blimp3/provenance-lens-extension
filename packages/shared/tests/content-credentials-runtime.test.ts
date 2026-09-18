import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  initializeContentCredentials,
  verifyContentCredentials,
} from "../src/content-credentials.js";

const SIGNED_FIXTURE_SHA256 =
  "a2d14755db55de67a47c04090340d8266e892367be4104a45626d7a6fa6e9ffd";
const signedFixtureUrl = new URL(
  "./fixtures/c2pa/signed-c2pa.jpg",
  import.meta.url,
);
const unsignedFixtureUrl = new URL(
  "../../../apps/extension/tests/fixtures/image-fixture.jpg",
  import.meta.url,
);

beforeAll(() => {
  const wasmPath = fileURLToPath(
    import.meta.resolve("@contentauth/c2pa-wasm/c2pa.wasm"),
  );
  initializeContentCredentials(new Uint8Array(readFileSync(wasmPath)).buffer);
});

it("validates, detects tampering, stays offline, and recovers after a reader error", async () => {
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Unexpected C2PA network access."));
  try {
    const signed = new Uint8Array(await readFile(signedFixtureUrl));
    expect(createHash("sha256").update(signed).digest("hex")).toBe(
      SIGNED_FIXTURE_SHA256,
    );

    const verified = await verifyContentCredentials(signed, "image/jpeg");
    expect(verified).toMatchObject({
      status: "verified",
      signatureValid: true,
      contentBindingValid: true,
      signerTrusted: false,
      issuer: "C2PA Test Signing Cert",
    });
    expect(verified.validationCodes).toContain("claimSignature.validated");
    expect(verified.validationCodes).toContain("assertion.dataHash.match");

    const tampered = signed.slice();
    const tamperedOffset = tampered.byteLength - 4096;
    tampered[tamperedOffset] = (tampered[tamperedOffset] ?? 0) ^ 1;
    const invalid = await verifyContentCredentials(tampered, "image/jpeg");
    expect(invalid.status).toBe("invalid");
    expect(invalid.validationCodes).toContain("assertion.dataHash.mismatch");

    const unsigned = new Uint8Array(await readFile(unsignedFixtureUrl));
    await expect(
      verifyContentCredentials(unsigned, "image/jpeg"),
    ).resolves.toMatchObject({ status: "not_present" });
    await expect(
      verifyContentCredentials(
        new Uint8Array([0xff, 0xd8, 1, 2, 3]),
        "image/jpeg",
      ),
    ).resolves.toMatchObject({ status: "unavailable" });
    await expect(
      verifyContentCredentials(signed, "image/jpeg"),
    ).resolves.toMatchObject({
      status: "verified",
      signatureValid: true,
      contentBindingValid: true,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
  }
});
