import {
  CacheMetadataSchema,
  DEFAULT_DETECTED_CACHE_TTL_SECONDS,
  DEFAULT_LOCAL_CACHE_LIMIT,
  DEFAULT_NO_SIGNAL_CACHE_TTL_SECONDS,
  IMAGE_RESULT_SCHEMA_VERSION,
  IMAGE_VERIFICATION_POLICY_VERSION,
  LocalVerificationCacheRecordSchema,
  NormalizedProvenanceResultSchema,
  RESULT_SCHEMA_VERSION,
  SupportedMediaMimeSchema,
  deriveCacheNamespace,
  parseBackendBaseUrl,
  sha256Hex,
  type CacheMetadata,
  type ExtensionSettings,
  type LocalVerificationCacheRecord,
  type NormalizedProvenanceResult,
  type Sha256,
  type SupportedMediaMime,
} from "@provenance-lens/shared";

const DATABASE_NAME = "provenance-lens-verification-cache";
const DATABASE_VERSION = 2;
const STORE_NAME = "verification-cache";
const CACHE_LIMIT_KEY = "provenanceLens.cacheLimit";

export type CacheSource = "fresh" | "local_cache" | "server_cache";

export interface CacheLookupMetadata {
  imageSha256: Sha256;
  byteLength: number;
  validatedMimeType: SupportedMediaMime;
  verificationPolicyVersion: string;
}

export interface CacheHit {
  result: NormalizedProvenanceResult;
  cache: CacheMetadata;
}

export async function sha256Text(value: string): Promise<Sha256> {
  return sha256Hex(new TextEncoder().encode(value));
}

export async function getCacheNamespace(
  settings: ExtensionSettings,
): Promise<{ backendOrigin: string; namespace: Sha256 } | null> {
  const clientIdentity = settings.clientToken.trim();
  if (!clientIdentity) return null;
  let backendOrigin: string;
  try {
    backendOrigin = parseBackendBaseUrl(settings.backendBaseUrl).origin;
  } catch {
    return null;
  }
  return {
    backendOrigin,
    namespace: await deriveCacheNamespace(backendOrigin, clientIdentity),
  };
}

export async function findLocalCache(
  settings: ExtensionSettings,
  metadata: CacheLookupMetadata,
): Promise<CacheHit | null> {
  const namespace = await getCacheNamespace(settings);
  if (!namespace) return null;

  const key = cacheKey(namespace.namespace, metadata.imageSha256);
  const database = await openDatabase();
  const rawRecord = await readRecord(database, key);
  const parsedRecord = parseRecord(rawRecord);
  if (!parsedRecord) {
    if (rawRecord) await deleteRecord(database, key);
    return null;
  }

  const record = parsedRecord.data;
  if (
    record.namespace !== namespace.namespace ||
    record.imageSha256 !== metadata.imageSha256 ||
    record.byteLength !== metadata.byteLength ||
    record.validatedMimeType !== metadata.validatedMimeType ||
    record.verificationPolicyVersion !== metadata.verificationPolicyVersion ||
    record.resultSchemaVersion !==
      (metadata.verificationPolicyVersion === IMAGE_VERIFICATION_POLICY_VERSION
        ? IMAGE_RESULT_SCHEMA_VERSION
        : RESULT_SCHEMA_VERSION) ||
    (metadata.verificationPolicyVersion === IMAGE_VERIFICATION_POLICY_VERSION &&
      !record.result.contentCredentials)
  ) {
    return null;
  }
  if (!isFresh(record.expiresAt)) {
    await deleteRecord(database, key);
    return null;
  }

  record.lastAccessedAt = new Date().toISOString();
  await putRecord(database, key, record);
  return {
    result: record.result,
    cache: {
      source: "local_cache",
      originallyCheckedAt: record.originallyCheckedAt,
      expiresAt: record.expiresAt,
      verificationPolicyVersion: record.verificationPolicyVersion,
      resultSchemaVersion: record.resultSchemaVersion,
    },
  };
}

export async function saveLocalCache(
  settings: ExtensionSettings,
  metadata: CacheLookupMetadata,
  result: NormalizedProvenanceResult,
  cache: CacheMetadata,
): Promise<void> {
  const parsedResult = NormalizedProvenanceResultSchema.safeParse(result);
  const parsedCache = CacheMetadataSchema.safeParse(cache);
  if (!parsedResult.success || !parsedCache.success) return;
  if (
    !isCacheableResult(parsedResult.data) ||
    !isFresh(parsedCache.data.expiresAt)
  )
    return;
  if (
    parsedCache.data.verificationPolicyVersion !==
      metadata.verificationPolicyVersion ||
    parsedCache.data.resultSchemaVersion !==
      (metadata.verificationPolicyVersion === IMAGE_VERIFICATION_POLICY_VERSION
        ? IMAGE_RESULT_SCHEMA_VERSION
        : RESULT_SCHEMA_VERSION) ||
    (metadata.verificationPolicyVersion === IMAGE_VERIFICATION_POLICY_VERSION &&
      !parsedResult.data.contentCredentials)
  ) {
    return;
  }

  const namespace = await getCacheNamespace(settings);
  if (!namespace) return;
  const parsedMime = SupportedMediaMimeSchema.safeParse(
    metadata.validatedMimeType,
  );
  if (!parsedMime.success) return;
  const timestamp = new Date().toISOString();
  const record: LocalVerificationCacheRecord = {
    namespace: namespace.namespace,
    imageSha256: metadata.imageSha256,
    byteLength: metadata.byteLength,
    validatedMimeType: parsedMime.data,
    verdict: parsedResult.data.verdict,
    result: parsedResult.data,
    originallyCheckedAt: parsedCache.data.originallyCheckedAt,
    lastAccessedAt: timestamp,
    expiresAt: parsedCache.data.expiresAt,
    verificationPolicyVersion: parsedCache.data.verificationPolicyVersion,
    resultSchemaVersion: parsedCache.data.resultSchemaVersion,
  };
  const parsedRecord = LocalVerificationCacheRecordSchema.safeParse(record);
  if (!parsedRecord.success) return;

  const database = await openDatabase();
  await putRecord(
    database,
    cacheKey(namespace.namespace, metadata.imageSha256),
    parsedRecord.data,
  );
  await enforceCacheLimit(
    database,
    namespace.namespace,
    settings.localCacheLimit,
  );
}

export async function clearVerificationCache(): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const request = database
      .transaction(STORE_NAME, "readwrite")
      .objectStore(STORE_NAME)
      .clear();
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error("Unable to clear verification cache."));
  });
}

export async function setCacheLimit(limit: number): Promise<void> {
  const safeLimit = isCacheLimit(limit) ? limit : DEFAULT_LOCAL_CACHE_LIMIT;
  await chrome.storage.local.set({ [CACHE_LIMIT_KEY]: safeLimit });
  const database = await openDatabase();
  const namespaces = await readNamespaces(database);
  for (const namespace of namespaces)
    await enforceCacheLimit(database, namespace, safeLimit);
}

export function isCacheableResult(
  result: NormalizedProvenanceResult,
): result is NormalizedProvenanceResult & {
  verdict: "openai_signal_detected" | "no_supported_openai_signal";
} {
  return (
    result.verdict === "openai_signal_detected" ||
    result.verdict === "no_supported_openai_signal"
  );
}

export function defaultExpiryForVerdict(
  verdict: NormalizedProvenanceResult["verdict"],
  now = Date.now(),
): string | null {
  if (verdict === "openai_signal_detected") {
    return new Date(
      now + DEFAULT_DETECTED_CACHE_TTL_SECONDS * 1_000,
    ).toISOString();
  }
  if (verdict === "no_supported_openai_signal") {
    return new Date(
      now + DEFAULT_NO_SIGNAL_CACHE_TTL_SECONDS * 1_000,
    ).toISOString();
  }
  return null;
}

function cacheKey(namespace: Sha256, imageSha256: Sha256): string {
  return `${namespace}:${imageSha256}`;
}

function isCacheLimit(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 10 &&
    value <= 1_000
  );
}

function isFresh(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

function parseRecord(
  value: unknown,
): { data: LocalVerificationCacheRecord } | null {
  const parsed = LocalVerificationCacheRecordSchema.safeParse(value);
  return parsed.success ? { data: parsed.data } : null;
}

async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.objectStoreNames.contains(STORE_NAME)
        ? request.transaction?.objectStore(STORE_NAME)
        : database.createObjectStore(STORE_NAME);
      if (!store) throw new Error("Unable to upgrade verification cache.");
      if (!store.indexNames.contains("namespace"))
        store.createIndex("namespace", "namespace", { unique: false });
      if (!store.indexNames.contains("verdict"))
        store.createIndex("verdict", "verdict", { unique: false });
      if (!store.indexNames.contains("lastAccessedAt"))
        store.createIndex("lastAccessedAt", "lastAccessedAt", {
          unique: false,
        });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Unable to open verification cache."));
  });
}

async function readRecord(
  database: IDBDatabase,
  key: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = database
      .transaction(STORE_NAME, "readonly")
      .objectStore(STORE_NAME)
      .get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () =>
      reject(request.error ?? new Error("Unable to read verification cache."));
  });
}

async function putRecord(
  database: IDBDatabase,
  key: string,
  record: LocalVerificationCacheRecord,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = database
      .transaction(STORE_NAME, "readwrite")
      .objectStore(STORE_NAME)
      .put(record, key);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error("Unable to write verification cache."));
  });
}

async function deleteRecord(database: IDBDatabase, key: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = database
      .transaction(STORE_NAME, "readwrite")
      .objectStore(STORE_NAME)
      .delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(
        request.error ?? new Error("Unable to delete verification cache."),
      );
  });
}

async function readNamespaceRecords(
  database: IDBDatabase,
  namespace: Sha256,
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const records: unknown[] = [];
    const request = database
      .transaction(STORE_NAME, "readonly")
      .objectStore(STORE_NAME)
      .index("namespace")
      .openCursor(IDBKeyRange.only(namespace));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(records);
        return;
      }
      records.push(cursor.value);
      cursor.continue();
    };
    request.onerror = () =>
      reject(request.error ?? new Error("Unable to read verification cache."));
  });
}

async function readNamespaces(database: IDBDatabase): Promise<Sha256[]> {
  return new Promise((resolve, reject) => {
    const namespaces = new Set<Sha256>();
    const request = database
      .transaction(STORE_NAME, "readonly")
      .objectStore(STORE_NAME)
      .index("namespace")
      .openKeyCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve([...namespaces]);
        return;
      }
      if (typeof cursor.key === "string") namespaces.add(cursor.key);
      cursor.continue();
    };
    request.onerror = () =>
      reject(
        request.error ?? new Error("Unable to inspect verification cache."),
      );
  });
}

async function enforceCacheLimit(
  database: IDBDatabase,
  namespace: Sha256,
  limit: number,
): Promise<void> {
  const records = (await readNamespaceRecords(database, namespace))
    .map((record) => parseRecord(record)?.data)
    .filter(
      (record): record is LocalVerificationCacheRecord => record !== undefined,
    );
  if (records.length <= limit) return;
  records.sort((left, right) =>
    left.lastAccessedAt.localeCompare(right.lastAccessedAt),
  );
  for (const record of records.slice(0, records.length - limit)) {
    await deleteRecord(
      database,
      cacheKey(record.namespace, record.imageSha256),
    );
  }
}
