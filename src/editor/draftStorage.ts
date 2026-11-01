import type { ProtoDefKitBundle, ProtoDefOperationScope } from '../protodefs/types';

const DATABASE_NAME = 'warpaint-viewer';
const DATABASE_VERSION = 2;
const DRAFT_STORE_NAME = 'editor-drafts';
const CUSTOM_SOURCE_STORE_NAME = 'custom-source-files';
export const DRAFT_VERSION = 2;
// Version 1 drafts held one operation under `messages`. They are still read, as a one-operation bundle.
const LEGACY_DRAFT_VERSION = 1;
const CUSTOM_SOURCE_VERSION = 1;

export type CustomSourceFileKind = 'package' | 'definitions';

export interface CustomSourceFileRecord {
  version: typeof CUSTOM_SOURCE_VERSION;
  key: CustomSourceFileKind;
  savedAt: number;
  files: File[];
}

export interface EditorDraftRecord {
  version: typeof DRAFT_VERSION;
  key: string;
  kitId: number;
  paintName?: string;
  savedAt: number;
  bundle: ProtoDefKitBundle;
}

let databasePromise: Promise<IDBDatabase> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordList(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null;
  const records = value.filter(isRecord);
  return records.length === value.length ? records : null;
}

function parseScopes(value: unknown, operationCount: number): ProtoDefOperationScope[] | null {
  if (!Array.isArray(value)) return null;
  const scopes = value.filter((entry): entry is ProtoDefOperationScope => (
    isRecord(entry)
    && typeof entry.weaponKey === 'string'
    && typeof entry.wear === 'number'
    && typeof entry.operationIndex === 'number'
    && Number.isSafeInteger(entry.operationIndex)
    && entry.operationIndex >= 0
    && entry.operationIndex < operationCount
  ));
  return scopes.length === value.length ? scopes : null;
}

function parseKitBundle(value: unknown): ProtoDefKitBundle | null {
  if (!isRecord(value) || !isRecord(value.definition)) return null;
  const operations = recordList(value.operations);
  const itemDefinitions = recordList(value.itemDefinitions);
  const scopes = operations && parseScopes(value.scopes, operations.length);
  if (!operations || operations.length === 0 || !itemDefinitions || !scopes) return null;
  return { definition: value.definition, operations, itemDefinitions, scopes };
}

function parseLegacyMessages(value: unknown): ProtoDefKitBundle | null {
  if (!isRecord(value) || !isRecord(value.definition) || !isRecord(value.operation)) return null;
  return { definition: value.definition, operations: [value.operation], itemDefinitions: [], scopes: [] };
}

export function parseEditorDraftRecord(value: unknown, expectedKey: string): EditorDraftRecord | null {
  if (!isRecord(value)
    || value.key !== expectedKey
    || typeof value.kitId !== 'number'
    || !Number.isSafeInteger(value.kitId)
    || typeof value.savedAt !== 'number'
    || !Number.isFinite(value.savedAt)
    || (value.paintName !== undefined && typeof value.paintName !== 'string')) return null;

  const bundle = value.version === DRAFT_VERSION
    ? parseKitBundle(value.bundle)
    : value.version === LEGACY_DRAFT_VERSION
      ? parseLegacyMessages(value.messages)
      : null;
  if (!bundle) return null;

  return {
    version: DRAFT_VERSION,
    key: value.key,
    kitId: value.kitId,
    ...(value.paintName === undefined ? {} : { paintName: value.paintName }),
    savedAt: value.savedAt,
    bundle,
  };
}

export function parseCustomSourceFileRecord(
  value: unknown,
  expectedKey: CustomSourceFileKind,
): CustomSourceFileRecord | null {
  if (!isRecord(value)
    || value.version !== CUSTOM_SOURCE_VERSION
    || value.key !== expectedKey
    || typeof value.savedAt !== 'number'
    || !Number.isFinite(value.savedAt)
    || !Array.isArray(value.files)
    || value.files.length === 0
    || !value.files.every((file) => file instanceof File)) return null;

  return {
    version: CUSTOM_SOURCE_VERSION,
    key: expectedKey,
    savedAt: value.savedAt,
    files: value.files,
  };
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DRAFT_STORE_NAME)) {
        request.result.createObjectStore(DRAFT_STORE_NAME, { keyPath: 'key' });
      }
      if (!request.result.objectStoreNames.contains(CUSTOM_SOURCE_STORE_NAME)) {
        request.result.createObjectStore(CUSTOM_SOURCE_STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error('The local draft database could not be opened.'));
    request.onblocked = () => reject(new Error('The local draft database is blocked by another tab.'));
  });
  databasePromise.catch(() => { databasePromise = null; });
  return databasePromise;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('The local draft request failed.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('The local draft transaction failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('The local draft transaction was cancelled.'));
  });
}

export async function readEditorDraft(key: string): Promise<EditorDraftRecord | null> {
  const database = await openDatabase();
  const value: unknown = await requestResult(database.transaction(DRAFT_STORE_NAME).objectStore(DRAFT_STORE_NAME).get(key));
  return parseEditorDraftRecord(value, key);
}

export async function writeEditorDraft(record: EditorDraftRecord): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(DRAFT_STORE_NAME, 'readwrite');
  transaction.objectStore(DRAFT_STORE_NAME).put(record);
  await transactionDone(transaction);
}

export async function deleteEditorDraft(key: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(DRAFT_STORE_NAME, 'readwrite');
  transaction.objectStore(DRAFT_STORE_NAME).delete(key);
  await transactionDone(transaction);
}

export async function readCustomSourceFiles(key: CustomSourceFileKind): Promise<File[] | null> {
  const database = await openDatabase();
  const value: unknown = await requestResult(
    database.transaction(CUSTOM_SOURCE_STORE_NAME).objectStore(CUSTOM_SOURCE_STORE_NAME).get(key),
  );
  return parseCustomSourceFileRecord(value, key)?.files ?? null;
}

export async function writeCustomSourceFiles(key: CustomSourceFileKind, files: File[]): Promise<void> {
  if (files.length === 0) return;
  const database = await openDatabase();
  const transaction = database.transaction(CUSTOM_SOURCE_STORE_NAME, 'readwrite');
  const record: CustomSourceFileRecord = {
    version: CUSTOM_SOURCE_VERSION,
    key,
    savedAt: Date.now(),
    files,
  };
  transaction.objectStore(CUSTOM_SOURCE_STORE_NAME).put(record);
  await transactionDone(transaction);
}

export async function deleteCustomSourceFiles(key: CustomSourceFileKind): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(CUSTOM_SOURCE_STORE_NAME, 'readwrite');
  transaction.objectStore(CUSTOM_SOURCE_STORE_NAME).delete(key);
  await transactionDone(transaction);
}

/**
 * Draft keys are `custom:<defindex>:<file>` for imported paints and `stock:<kitId>` for built-in ones.
 * Only imported drafts belong to a workspace; stock drafts survive clearing the imports.
 */
const CUSTOM_DRAFT_PREFIX = 'custom:';

function selectWorkspaceDraftKeys(keys: readonly IDBValidKey[]): string[] {
  return keys.filter((key): key is string => typeof key === 'string' && key.startsWith(CUSTOM_DRAFT_PREFIX));
}

export interface WorkspaceClearResult {
  drafts: number;
  sources: number;
}

/** Removes imported sources and imported-paint drafts in one transaction, so a partial delete cannot return on reload. */
export async function clearCustomWorkspace(): Promise<WorkspaceClearResult> {
  const database = await openDatabase();
  const transaction = database.transaction([DRAFT_STORE_NAME, CUSTOM_SOURCE_STORE_NAME], 'readwrite');
  const draftStore = transaction.objectStore(DRAFT_STORE_NAME);
  const sourceStore = transaction.objectStore(CUSTOM_SOURCE_STORE_NAME);

  // Issue both reads before the first await, or the transaction may go inactive.
  const [draftKeys, sourceKeys] = await Promise.all([
    requestResult(draftStore.getAllKeys()),
    requestResult(sourceStore.getAllKeys()),
  ]);

  const workspaceDraftKeys = selectWorkspaceDraftKeys(draftKeys);
  for (const key of workspaceDraftKeys) draftStore.delete(key);
  for (const key of sourceKeys) sourceStore.delete(key);

  await transactionDone(transaction);
  return { drafts: workspaceDraftKeys.length, sources: sourceKeys.length };
}
