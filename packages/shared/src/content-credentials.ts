import { WasmReader, initSync, type InitInput } from "@contentauth/c2pa-wasm";

import { MAX_CONTENT_CREDENTIALS_BYTES } from "./constants.js";
import { sanitizeDisplayText } from "./normalize.js";
import type { ContentCredentials, SupportedImageMime } from "./schemas.js";
import trustList from "./trust/c2pa-trust-list.json" with { type: "json" };

const ACTION_LIMIT = 20;
const VALIDATION_CODE_LIMIT = 30;
const HARD_BINDING_MATCHES = new Set([
  "assertion.dataHash.match",
  "assertion.bmffHash.match",
  "assertion.boxesHash.match",
  "assertion.collectionHash.match",
]);
const SUPPORTED_MIME_TYPES = new Set<SupportedImageMime>([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const TRAINED_ALGORITHMIC_MEDIA =
  "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";
const COMPOSITE_WITH_TRAINED_ALGORITHMIC_MEDIA =
  "http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia";
const READER_CONTEXT = JSON.stringify({
  version: 1,
  core: {
    allowed_network_hosts: [],
    max_decompressed_manifest_size_in_mb: 4,
  },
  trust: {
    anchors: [
      {
        trust_anchors: trustList.anchors,
        trust_kind: "manifest",
      },
      {
        trust_anchors: trustList.timestampAnchors,
        trust_kind: "tsa",
      },
    ],
  },
  verify: {
    verify_after_reading: true,
    verify_trust: true,
    verify_timestamp_trust: true,
    remote_manifest_fetch: false,
    ocsp_fetch: false,
  },
});

type UnknownRecord = Record<string, unknown>;

class ByteBackedBlob {
  readonly size: number;
  readonly type: string;

  constructor(
    readonly bytes: Uint8Array<ArrayBuffer>,
    type = "",
  ) {
    this.size = bytes.byteLength;
    this.type = type;
  }

  slice(start = 0, end = this.size, type = ""): ByteBackedBlob {
    const from = normalizeBlobIndex(start, this.size);
    const to = Math.max(normalizeBlobIndex(end, this.size), from);
    return new ByteBackedBlob(this.bytes.subarray(from, to), type);
  }
}

class ByteBackedFileReaderSync {
  readAsArrayBuffer(blob: unknown): ArrayBuffer {
    if (!(blob instanceof ByteBackedBlob)) {
      throw new TypeError("Unsupported C2PA blob implementation.");
    }
    return blob.bytes.byteOffset === 0 &&
      blob.bytes.byteLength === blob.bytes.buffer.byteLength
      ? blob.bytes.buffer
      : blob.bytes.buffer.slice(
          blob.bytes.byteOffset,
          blob.bytes.byteOffset + blob.bytes.byteLength,
        );
  }
}

export function initializeContentCredentials(module: InitInput): void {
  const runtime = globalThis as typeof globalThis & {
    FileReaderSync?: typeof ByteBackedFileReaderSync;
  };
  runtime.FileReaderSync ??= ByteBackedFileReaderSync;
  initSync({ module });
}

export async function verifyContentCredentials(
  bytes: Uint8Array,
  mimeType: SupportedImageMime,
): Promise<ContentCredentials> {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    !SUPPORTED_MIME_TYPES.has(mimeType)
  ) {
    return unavailableContentCredentials("c2pa.input.unsupported");
  }
  if (bytes.byteLength > MAX_CONTENT_CREDENTIALS_BYTES) {
    return unavailableContentCredentials("c2pa.input.too_large");
  }

  let reader: WasmReader | undefined;
  try {
    reader = await WasmReader.fromBlob(
      mimeType,
      new ByteBackedBlob(arrayBufferBytes(bytes), mimeType) as unknown as Blob,
      READER_CONTEXT,
    );
    return normalizeReader(reader);
  } catch (error) {
    return isManifestMissing(error)
      ? empty("not_present")
      : unavailableContentCredentials("c2pa.reader.unavailable");
  } finally {
    reader?.free();
  }
}

function arrayBufferBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
}

function normalizeReader(reader: WasmReader): ContentCredentials {
  const store = asRecord(reader.manifestStore());
  const activeManifest = asRecord(reader.activeManifest());
  const validationResults = asRecord(store?.["validation_results"]);
  const activeResults = asRecord(validationResults?.["activeManifest"]);
  const success = records(activeResults?.["success"]);
  const informational = records(activeResults?.["informational"]);
  const failure = records(activeResults?.["failure"]);
  const successCodes = new Set(statusCodes(success));
  const validatedActionAssertions = validatedActionAssertionLabels(success);
  const validationCodes = cappedCodes(failure, informational, success);
  const signatureValid =
    successCodes.has("claimSignature.validated") &&
    successCodes.has("claimSignature.insideValidity");
  const contentBindingValid = [...HARD_BINDING_MATCHES].some((code) =>
    successCodes.has(code),
  );
  const integrityFailure = failure.some(
    (entry) => !isToleratedFailure(statusCode(entry)),
  );
  const signerTrusted =
    successCodes.has("signingCredential.trusted") &&
    !failure.some(
      (entry) => statusCode(entry) === "signingCredential.untrusted",
    );

  if (integrityFailure) {
    return {
      ...empty("invalid"),
      signatureValid,
      contentBindingValid: false,
      issuer: signatureValid ? issuer(activeManifest) : null,
      validationCodes,
    };
  }

  if (
    !store ||
    !activeManifest ||
    !activeResults ||
    !signatureValid ||
    !contentBindingValid
  ) {
    return {
      ...empty("unavailable"),
      signatureValid,
      contentBindingValid,
      issuer: signatureValid ? issuer(activeManifest) : null,
      validationCodes,
    };
  }

  const actionEvidence = signedActionEvidence(
    activeManifest,
    validatedActionAssertions,
  );
  return {
    status: "verified",
    signatureValid: true,
    contentBindingValid: true,
    signerTrusted,
    issuer: issuer(activeManifest),
    actions: actionEvidence.actions,
    aiDeclaration: actionEvidence.aiDeclaration,
    validationCodes,
    trustListVersion: trustList.version,
  };
}

function signedActionEvidence(
  activeManifest: UnknownRecord,
  validatedAssertions: ReadonlySet<string>,
): Pick<ContentCredentials, "actions" | "aiDeclaration"> {
  const output: ContentCredentials["actions"] = [];
  let declaration: ContentCredentials["aiDeclaration"] = null;
  for (const assertion of records(activeManifest["assertions"])) {
    if (
      assertion["created"] !== true ||
      typeof assertion["label"] !== "string" ||
      !isActionsLabel(assertion["label"]) ||
      !validatedAssertions.has(actionAssertionUriLabel(assertion))
    ) {
      continue;
    }
    const data = asRecord(assertion["data"]);
    for (const action of records(data?.["actions"])) {
      const rawAction = action["action"];
      const rawSourceType = action["digitalSourceType"];
      const actionName = sanitizedString(rawAction, 128);
      if (!actionName) continue;
      if (output.length < ACTION_LIMIT) {
        output.push({
          action: actionName,
          digitalSourceType: sanitizedString(rawSourceType, 256),
        });
      }
      if (rawAction === "c2pa.created" || rawAction === "c2pa.edited") {
        if (rawSourceType === TRAINED_ALGORITHMIC_MEDIA) {
          declaration = "generated";
        } else if (
          declaration === null &&
          rawSourceType === COMPOSITE_WITH_TRAINED_ALGORITHMIC_MEDIA
        ) {
          declaration = "edited";
        }
      }
    }
  }
  return { actions: output, aiDeclaration: declaration };
}

function validatedActionAssertionLabels(success: UnknownRecord[]): Set<string> {
  return new Set(
    success.flatMap((entry) => {
      if (
        statusCode(entry) !== "assertion.hashedURI.match" ||
        typeof entry["url"] !== "string"
      ) {
        return [];
      }
      const label = entry["url"].split("/").at(-1) ?? "";
      return isActionsUriLabel(label) ? [label] : [];
    }),
  );
}

function isActionsLabel(value: string): boolean {
  return value === "c2pa.actions" || /^c2pa\.actions\.v[1-9]\d*$/u.test(value);
}

function isActionsUriLabel(value: string): boolean {
  return value === "c2pa.actions" || /^c2pa\.actions__[1-9]\d*$/u.test(value);
}

function actionAssertionUriLabel(assertion: UnknownRecord): string {
  const instance = assertion["instance"];
  return instance === undefined
    ? "c2pa.actions"
    : typeof instance === "number" &&
        Number.isSafeInteger(instance) &&
        instance > 0
      ? `c2pa.actions__${String(instance)}`
      : "";
}

function cappedCodes(...groups: UnknownRecord[][]): string[] {
  const output = new Set<string>();
  for (const group of groups) {
    for (const entry of group) {
      const code = sanitizedString(entry["code"], 128);
      if (code) output.add(code);
      if (output.size === VALIDATION_CODE_LIMIT) return [...output];
    }
  }
  return [...output];
}

function statusCodes(entries: UnknownRecord[]): string[] {
  return entries.flatMap((entry) => {
    const code = statusCode(entry);
    return code ? [code] : [];
  });
}

function statusCode(entry: UnknownRecord): string | null {
  const code = entry["code"];
  return typeof code === "string" && code.length > 0 ? code : null;
}

function isToleratedFailure(code: string | null): boolean {
  return (
    code === "signingCredential.untrusted" ||
    code?.startsWith("cawg.x509.") === true
  );
}

function issuer(activeManifest: UnknownRecord | null): string | null {
  return sanitizedString(
    asRecord(activeManifest?.["signature_info"])?.["issuer"],
    512,
  );
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const record = asRecord(entry);
        return record ? [record] : [];
      })
    : [];
}

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function sanitizedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = sanitizeDisplayText(value, maxLength);
  return normalized.length > 0 ? normalized : null;
}

function normalizeBlobIndex(value: number, size: number): number {
  const integer = Number.isNaN(value) ? 0 : Math.trunc(value);
  return integer < 0 ? Math.max(size + integer, 0) : Math.min(integer, size);
}

function isManifestMissing(error: unknown): boolean {
  return error === "C2pa(JumbfNotFound)";
}

export function unavailableContentCredentials(
  code: string,
): ContentCredentials {
  return { ...empty("unavailable"), validationCodes: [code] };
}

function empty(status: ContentCredentials["status"]): ContentCredentials {
  return {
    status,
    signatureValid: false,
    contentBindingValid: false,
    signerTrusted: false,
    issuer: null,
    actions: [],
    aiDeclaration: null,
    validationCodes: [],
    trustListVersion: trustList.version,
  };
}
