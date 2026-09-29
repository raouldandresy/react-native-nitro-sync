import type { SyncMutation, SyncRecord, SyncTransportRequest, SyncTransportResponse } from './types';

export const SYNC_PROTOCOL_VERSION = 1;

export function buildSyncRequestPayload(
  tableName: string,
  mutations: readonly SyncMutation[],
  lastSyncedAt: number | null,
  serverCursor?: string | null,
  serverVersion?: number | null,
  deviceId?: string,
): SyncTransportRequest {
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    tableName,
    mutations,
    lastSyncedAt,
    ...(deviceId === undefined ? {} : { deviceId }),
    ...(serverCursor === undefined ? {} : { serverCursor }),
    ...(serverVersion === undefined ? {} : { serverVersion }),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeSyncResponse<T extends SyncRecord>(
  value: unknown,
): Required<Pick<SyncTransportResponse<T>, 'protocolVersion' | 'acknowledgedMutationIds' | 'serverTimestamp' | 'serverCursor' | 'serverVersion' | 'tombstones' | 'rejectedMutations'>> & Pick<SyncTransportResponse<T>, 'records'> {
  if (!isObject(value)) {
    throw new Error('Invalid sync response: expected an object');
  }
  const response = value;
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
    records: response.records as readonly T[] | undefined,
    tombstones: (response.tombstones as SyncTransportResponse<T>['tombstones']) ?? [],
    acknowledgedMutationIds: (response.acknowledgedMutationIds as readonly string[] | undefined) ?? [],
    rejectedMutations: (response.rejectedMutations as SyncTransportResponse<T>['rejectedMutations']) ?? [],
    serverTimestamp: (response.serverTimestamp as number | undefined) ?? Date.now(),
    serverCursor: (response.serverCursor as string | null | undefined) ?? null,
    serverVersion: (response.serverVersion as number | null | undefined) ?? null,
  };
}
