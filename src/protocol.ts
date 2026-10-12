import type {
  SyncMutation,
  SyncRecord,
  SyncSchemaMigration,
  SyncTransportRequest,
  SyncTransportResponse,
} from './types';

export const SYNC_PROTOCOL_VERSION = 1;

export function buildSyncRequestPayload(
  tableName: string,
  mutations: readonly SyncMutation[],
  lastSyncedAt: number | null,
  serverCursor?: string | null,
  serverVersion?: number | null,
  deviceId?: string,
  schemaVersion?: number,
  migration?: SyncSchemaMigration | null,
): SyncTransportRequest {
  if (schemaVersion !== undefined &&
    (!Number.isSafeInteger(schemaVersion) || schemaVersion <= 0)) {
    throw new Error('Invalid application schemaVersion: expected a positive safe integer');
  }
  if (migration !== undefined && migration !== null) {
    if (schemaVersion === undefined) {
      throw new Error('Invalid schema migration metadata: schemaVersion is required');
    }
    validateSchemaMigration(migration);
    if (migration.fromVersion >= schemaVersion) {
      throw new Error('Invalid schema migration metadata: fromVersion must be older than schemaVersion');
    }
  }
  for (const mutation of mutations) {
    if (mutation.dependsOn !== undefined && (
      !Array.isArray(mutation.dependsOn) ||
      mutation.dependsOn.some((dependency: string) => typeof dependency !== 'string' || dependency.length === 0) ||
      new Set(mutation.dependsOn).size !== mutation.dependsOn.length ||
      mutation.dependsOn.includes(mutation.id)
    )) {
      throw new Error(`Invalid mutation dependencies for "${mutation.id}"`);
    }
  }
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    tableName,
    mutations,
    lastSyncedAt,
    ...(deviceId === undefined ? {} : { deviceId }),
    ...(serverCursor === undefined ? {} : { serverCursor }),
    ...(serverVersion === undefined ? {} : { serverVersion }),
    ...(schemaVersion === undefined ? {} : { schemaVersion }),
    ...(migration === undefined ? {} : { migration }),
  };
}

export function assertCompatibleSchemaVersion(
  schemaVersion: number,
  minimumSchemaVersion: number | undefined,
): void {
  if (
    !Number.isSafeInteger(schemaVersion) ||
    schemaVersion <= 0
  ) {
    throw new Error('Invalid application schemaVersion: expected a positive safe integer');
  }
  if (minimumSchemaVersion !== undefined && schemaVersion < minimumSchemaVersion) {
    throw new Error(
      `Unsupported application schema version ${schemaVersion}; server requires ${minimumSchemaVersion}`,
    );
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateSchemaMigration(migration: SyncSchemaMigration): void {
  if (
    !Number.isSafeInteger(migration.fromVersion) ||
    migration.fromVersion <= 0 ||
    !Array.isArray(migration.tables) ||
    migration.tables.some((table) => typeof table !== 'string') ||
    !isObject(migration.columns) ||
    Object.entries(migration.columns).some(([, columns]) => (
      !Array.isArray(columns) || columns.some((column) => typeof column !== 'string')
    ))
  ) {
    throw new Error('Invalid schema migration metadata');
  }
}

export function normalizeSyncResponse<T extends SyncRecord>(
  value: unknown,
): Required<Pick<SyncTransportResponse<T>, 'protocolVersion' | 'acknowledgedMutationIds' | 'serverTimestamp' | 'tombstones' | 'rejectedMutations'>>
  & Pick<SyncTransportResponse<T>, 'records' | 'serverCursor' | 'serverVersion' | 'resetRequired' | 'minimumSchemaVersion' | 'idMap'> {
  if (!isObject(value)) {
    throw new Error('Invalid sync response: expected an object');
  }
  const response = value;
  if (response.idMap !== undefined && (
    !isObject(response.idMap) ||
    Object.entries(response.idMap).some(([from, to]) => (
      from.length === 0 || typeof to !== 'string' || to.length === 0
    ))
  )) {
    throw new Error('Invalid sync response: idMap must map non-empty IDs to non-empty strings');
  }
  if (
    response.resetRequired !== undefined &&
    typeof response.resetRequired !== 'boolean'
  ) {
    throw new Error('Invalid sync response: resetRequired must be a boolean');
  }
  if (
    response.minimumSchemaVersion !== undefined &&
    (typeof response.minimumSchemaVersion !== 'number' ||
      !Number.isSafeInteger(response.minimumSchemaVersion) ||
      response.minimumSchemaVersion <= 0)
  ) {
    throw new Error('Invalid sync response: minimumSchemaVersion must be a positive safe integer');
  }
  if (response.resetRequired === true && response.records === undefined) {
    throw new Error('Invalid sync response: resetRequired requires records');
  }
  if (
    response.protocolVersion !== undefined &&
    response.protocolVersion !== SYNC_PROTOCOL_VERSION
  ) {
    throw new Error(`Unsupported sync protocol version ${String(response.protocolVersion)}`);
  }
  if (
    response.acknowledgedMutationIds !== undefined &&
    (!Array.isArray(response.acknowledgedMutationIds) ||
      response.acknowledgedMutationIds.some((id) => typeof id !== 'string'))
  ) {
    throw new Error('Invalid sync response: acknowledgedMutationIds must be an array of strings');
  }
  if (
    response.records !== undefined &&
    (!Array.isArray(response.records) ||
      response.records.some((record) => !isObject(record) || typeof record.id !== 'string'))
  ) {
    throw new Error('Invalid sync response: records must be an array of records with string IDs');
  }
  if (
    response.tombstones !== undefined &&
    (!Array.isArray(response.tombstones) ||
      response.tombstones.some((tombstone) => (
        !isObject(tombstone) ||
        typeof tombstone.id !== 'string' ||
        typeof tombstone.timestamp !== 'number' ||
        !Number.isFinite(tombstone.timestamp)
      )))
  ) {
    throw new Error('Invalid sync response: tombstones must contain string IDs and finite timestamps');
  }
  if (
    response.rejectedMutations !== undefined &&
    (!Array.isArray(response.rejectedMutations) ||
      response.rejectedMutations.some((rejection) => (
        !isObject(rejection) ||
        typeof rejection.mutationId !== 'string' ||
        typeof rejection.code !== 'string' ||
        (rejection.message !== undefined && typeof rejection.message !== 'string') ||
        (rejection.retryable !== undefined && typeof rejection.retryable !== 'boolean')
      )))
  ) {
    throw new Error('Invalid sync response: rejectedMutations has an invalid entry');
  }
  if (
    response.serverTimestamp !== undefined &&
    (typeof response.serverTimestamp !== 'number' || !Number.isFinite(response.serverTimestamp))
  ) {
    throw new Error('Invalid sync response: serverTimestamp must be a finite number');
  }
  if (
    response.serverCursor !== undefined &&
    response.serverCursor !== null &&
    typeof response.serverCursor !== 'string'
  ) {
    throw new Error('Invalid sync response: serverCursor must be a string or null');
  }
  if (
    response.serverVersion !== undefined &&
    response.serverVersion !== null &&
    (typeof response.serverVersion !== 'number' || !Number.isFinite(response.serverVersion))
  ) {
    throw new Error('Invalid sync response: serverVersion must be a finite number or null');
  }
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    ...(response.resetRequired === true ? { resetRequired: true } : {}),
    ...(response.minimumSchemaVersion === undefined
      ? {}
      : { minimumSchemaVersion: response.minimumSchemaVersion as number }),
    records: response.records as readonly T[] | undefined,
    tombstones: (response.tombstones as SyncTransportResponse<T>['tombstones']) ?? [],
    acknowledgedMutationIds: (response.acknowledgedMutationIds as readonly string[] | undefined) ?? [],
    rejectedMutations: (response.rejectedMutations as SyncTransportResponse<T>['rejectedMutations']) ?? [],
    serverTimestamp: (response.serverTimestamp as number | undefined) ?? Date.now(),
    ...(response.serverCursor === undefined
      ? {}
      : { serverCursor: response.serverCursor as string | null }),
    ...(response.serverVersion === undefined
      ? {}
      : { serverVersion: response.serverVersion as number | null }),
    ...(response.idMap === undefined ? {} : { idMap: response.idMap as Readonly<Record<string, string>> }),
  };
}
