import { transitionMutationState } from './stateMachine';
import type { SyncMutation, SyncMutationRejection, SyncMutationStatus } from './types';

export interface SyncMutationSettlement<T extends SyncMutation = SyncMutation> {
  readonly acknowledged: readonly T[];
  readonly unacknowledged: readonly T[];
  readonly rejected: readonly T[];
}

export interface SyncMutationSettlementHandlers {
  readonly acknowledge: (mutation: SyncMutation, status: SyncMutationStatus) => void;
  readonly retry: (mutation: SyncMutation, status: SyncMutationStatus) => void;
  readonly reject: (mutation: SyncMutation, status: SyncMutationStatus) => void;
}

export function partitionSyncMutations<T extends SyncMutation>(
  mutations: readonly T[],
  acknowledgedMutationIds: readonly string[],
  rejectedMutations: readonly SyncMutationRejection[] = [],
): SyncMutationSettlement<T> {
  const batchIds = new Set(mutations.map((mutation) => mutation.id));
  const acknowledgedIds = new Set(
    acknowledgedMutationIds.filter((mutationId) => batchIds.has(mutationId)),
  );
  const rejectedIds = new Set(
    rejectedMutations
      .filter((rejection) => (
        rejection.retryable === false &&
        batchIds.has(rejection.mutationId) &&
        !acknowledgedIds.has(rejection.mutationId)
      ))
      .map((rejection) => rejection.mutationId),
  );
  return {
    acknowledged: mutations.filter((mutation) => acknowledgedIds.has(mutation.id)),
    unacknowledged: mutations.filter(
      (mutation) => !acknowledgedIds.has(mutation.id) && !rejectedIds.has(mutation.id),
    ),
    rejected: mutations.filter((mutation) => rejectedIds.has(mutation.id)),
  };
}

export function settleSyncMutations<T extends SyncMutation>(
  settlement: SyncMutationSettlement<T>,
  handlers: SyncMutationSettlementHandlers,
): void {
  for (const mutation of settlement.acknowledged) {
    handlers.acknowledge(
      mutation,
      transitionMutationState('SYNCING', 'ACKED'),
    );
  }
  for (const mutation of settlement.unacknowledged) {
    handlers.retry(
      mutation,
      transitionMutationState('SYNCING', 'FAILED'),
    );
  }
  for (const mutation of settlement.rejected) {
    handlers.reject(
      mutation,
      transitionMutationState('SYNCING', 'REJECTED'),
    );
  }
}

export function failSyncMutations(
  mutations: readonly SyncMutation[],
  retry: (mutation: SyncMutation, status: SyncMutationStatus) => void,
): void {
  for (const mutation of mutations) {
    retry(mutation, transitionMutationState('SYNCING', 'FAILED'));
  }
}
