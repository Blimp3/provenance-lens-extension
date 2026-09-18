const sdk = vi.hoisted(() => ({
  fromBlob: vi.fn<(...arguments_: unknown[]) => Promise<unknown>>(),
  initSync: vi.fn(),
}));

vi.mock("@contentauth/c2pa-wasm", () => ({
  initSync: sdk.initSync,
  WasmReader: class {
    static fromBlob = sdk.fromBlob;
  },
}));

import {
  initializeContentCredentials,
  verifyContentCredentials,
} from "../src/content-credentials.js";

const validSuccess = [
  { code: "claimSignature.validated" },
  { code: "claimSignature.insideValidity" },
  { code: "assertion.dataHash.match" },
  {
    code: "assertion.hashedURI.match",
    url: "self#jumbf=/c2pa/test/c2pa.assertions/c2pa.actions",
  },
];

function fakeReader(options: {
  success?: unknown[];
  failure?: unknown[];
  informational?: unknown[];
  assertions?: unknown[];
  issuer?: unknown;
}) {
  const free = vi.fn();
  return {
    free,
    manifestStore: () => ({
      validation_results: {
        activeManifest: {
          success: options.success ?? validSuccess,
          informational: options.informational ?? [],
          failure: options.failure ?? [],
        },
      },
    }),
    activeManifest: () => ({
      signature_info: { issuer: options.issuer ?? "C2PA Issuer" },
      assertions: options.assertions ?? [],
    }),
  };
}

describe("Content Credentials verification", () => {
  beforeAll(() => {
    initializeContentCredentials(new Uint8Array([0]));
  });

  beforeEach(() => {
    sdk.fromBlob.mockReset();
  });

  it("reports valid active signed AI creation evidence and reads exact byte slices", async () => {
    const reader = fakeReader({
      issuer: ` ${"i".repeat(600)} `,
      assertions: [
        {
          label: "c2pa.actions.v2",
          created: true,
          data: {
            actions: [
              {
                action: "c2pa.created",
                digitalSourceType:
                  "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
              },
            ],
          },
        },
      ],
    });
    sdk.fromBlob.mockImplementation((_format, blob, context) => {
      const syncReader = new (
        globalThis as typeof globalThis & {
          FileReaderSync: new () => {
            readAsArrayBuffer(value: unknown): ArrayBuffer;
          };
        }
      ).FileReaderSync();
      const slice = (
        blob as { slice(start: number, end: number): unknown }
      ).slice(1, -1);
      expect([...new Uint8Array(syncReader.readAsArrayBuffer(slice))]).toEqual([
        2, 3,
      ]);
      expect(JSON.parse(context as string)).toMatchObject({
        core: {
          allowed_network_hosts: [],
          max_decompressed_manifest_size_in_mb: 4,
        },
        trust: {
          anchors: [{ trust_kind: "manifest" }, { trust_kind: "tsa" }],
        },
        verify: {
          remote_manifest_fetch: false,
          ocsp_fetch: false,
        },
      });
      return Promise.resolve(reader);
    });

    const result = await verifyContentCredentials(
      new Uint8Array([1, 2, 3, 4]),
      "image/jpeg",
    );

    expect(result).toMatchObject({
      status: "verified",
      signatureValid: true,
      contentBindingValid: true,
      signerTrusted: false,
      actions: [
        {
          action: "c2pa.created",
          digitalSourceType:
            "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
        },
      ],
      aiDeclaration: "generated",
      trustListVersion: "6273cdcb4f27",
    });
    expect(result.issuer).toHaveLength(512);
    expect(reader.free).toHaveBeenCalledOnce();
  });

  it("lets an active integrity failure override positive rows", async () => {
    const reader = fakeReader({
      success: [...validSuccess, { code: "signingCredential.trusted" }],
      failure: [{ code: "assertion.dataHash.mismatch" }],
      assertions: [
        {
          label: "c2pa.actions.v2",
          created: true,
          data: {
            actions: [
              {
                action: "c2pa.edited",
                digitalSourceType:
                  "http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia",
              },
            ],
          },
        },
      ],
    });
    sdk.fromBlob.mockResolvedValue(reader);

    const result = await verifyContentCredentials(
      new Uint8Array([1]),
      "image/jpeg",
    );

    expect(result).toMatchObject({
      status: "invalid",
      signatureValid: true,
      contentBindingValid: false,
      signerTrusted: false,
      actions: [],
      aiDeclaration: null,
    });
    expect(result.validationCodes[0]).toBe("assertion.dataHash.mismatch");
    expect(reader.free).toHaveBeenCalledOnce();
  });

  it("only promotes each exact hash-matched created action assertion", async () => {
    sdk.fromBlob.mockResolvedValue(
      fakeReader({
        success: [...validSuccess, { code: "signingCredential.trusted" }],
        assertions: [
          {
            label: "c2pa.actions.v2",
            data: {
              actions: [
                {
                  action: "c2pa.created",
                  digitalSourceType:
                    "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
                },
              ],
            },
          },
          {
            label: "c2pa.actions.v2",
            created: true,
            data: {
              actions: [
                {
                  action: "c2pa.created",
                  digitalSourceType:
                    "http://cv.iptc.org/newscodes/digitalsourcetype/algorithmicMedia",
                },
                {
                  action: " c2pa.created",
                  digitalSourceType:
                    "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
                },
                {
                  action: "c2pa.edited",
                  digitalSourceType:
                    " http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia",
                },
              ],
            },
          },
          {
            label: "c2pa.actionsmalicious",
            created: true,
            data: {
              actions: [
                {
                  action: "c2pa.created",
                  digitalSourceType:
                    "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
                },
              ],
            },
          },
          {
            label: "c2pa.actions.v2",
            instance: 1,
            created: true,
            data: {
              actions: [
                {
                  action: "c2pa.created",
                  digitalSourceType:
                    "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
                },
              ],
            },
          },
        ],
      }),
    );

    const result = await verifyContentCredentials(
      new Uint8Array([1]),
      "image/png",
    );

    expect(result.status).toBe("verified");
    expect(result.signerTrusted).toBe(true);
    expect(result.actions).toEqual([
      {
        action: "c2pa.created",
        digitalSourceType:
          "http://cv.iptc.org/newscodes/digitalsourcetype/algorithmicMedia",
      },
      {
        action: "c2pa.created",
        digitalSourceType:
          "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
      },
      {
        action: "c2pa.edited",
        digitalSourceType:
          "http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia",
      },
    ]);
    expect(result.aiDeclaration).toBeNull();
  });

  it("distinguishes no manifest from parser failure and recovers on the next request", async () => {
    const reader = fakeReader({});
    sdk.fromBlob
      .mockRejectedValueOnce(
        'C2pa(RemoteManifestUrl("https://example.test/manifest.c2pa"))',
      )
      .mockRejectedValueOnce("C2pa(UnsupportedType)")
      .mockRejectedValueOnce("C2pa(JumbfParseError(contains JumbfNotFound))")
      .mockRejectedValueOnce("C2pa(JumbfNotFound)")
      .mockResolvedValueOnce(reader);

    await expect(
      verifyContentCredentials(new Uint8Array([1]), "image/webp"),
    ).resolves.toMatchObject({ status: "unavailable" });
    await expect(
      verifyContentCredentials(new Uint8Array([1]), "image/webp"),
    ).resolves.toMatchObject({ status: "unavailable" });
    await expect(
      verifyContentCredentials(new Uint8Array([1]), "image/webp"),
    ).resolves.toMatchObject({ status: "unavailable" });
    await expect(
      verifyContentCredentials(new Uint8Array([1]), "image/webp"),
    ).resolves.toMatchObject({ status: "not_present" });
    await expect(
      verifyContentCredentials(new Uint8Array([1]), "image/webp"),
    ).resolves.toMatchObject({ status: "verified" });
    expect(reader.free).toHaveBeenCalledOnce();
  });

  it("sanitizes display fields and rejects inputs above the C2PA memory ceiling", async () => {
    const reader = fakeReader({
      issuer: "Issuer\u202e\nName",
      assertions: [
        {
          label: "c2pa.actions.v2",
          created: true,
          data: {
            actions: [
              {
                action: "c2pa.\u0000created",
                digitalSourceType: "source\u2066value",
              },
            ],
          },
        },
      ],
    });
    sdk.fromBlob.mockResolvedValue(reader);

    const atLimit = await verifyContentCredentials(
      new Uint8Array(4 * 1024 * 1024),
      "image/jpeg",
    );
    const aboveLimit = await verifyContentCredentials(
      new Uint8Array(4 * 1024 * 1024 + 1),
      "image/jpeg",
    );

    expect(atLimit).toMatchObject({
      status: "verified",
      issuer: "Issuer Name",
      actions: [{ action: "c2pa. created", digitalSourceType: "source value" }],
    });
    expect(aboveLimit).toMatchObject({
      status: "unavailable",
      validationCodes: ["c2pa.input.too_large"],
    });
    expect(sdk.fromBlob).toHaveBeenCalledOnce();
  });

  it("does not trust contradictory signer status rows", async () => {
    sdk.fromBlob.mockResolvedValue(
      fakeReader({
        success: [...validSuccess, { code: "signingCredential.trusted" }],
        failure: [{ code: "signingCredential.untrusted" }],
      }),
    );

    await expect(
      verifyContentCredentials(new Uint8Array([1]), "image/jpeg"),
    ).resolves.toMatchObject({
      status: "verified",
      signerTrusted: false,
    });
  });

  it("keeps scanning for an AI declaration after the action display cap", async () => {
    sdk.fromBlob.mockResolvedValue(
      fakeReader({
        assertions: [
          {
            label: "c2pa.actions.v2",
            created: true,
            data: {
              actions: [
                ...Array.from({ length: 20 }, (_, index) => ({
                  action: `example.action.${String(index)}`,
                })),
                {
                  action: "c2pa.created",
                  digitalSourceType:
                    "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
                },
              ],
            },
          },
        ],
      }),
    );

    const result = await verifyContentCredentials(
      new Uint8Array([1]),
      "image/jpeg",
    );

    expect(result.actions).toHaveLength(20);
    expect(result.aiDeclaration).toBe("generated");
  });
});
