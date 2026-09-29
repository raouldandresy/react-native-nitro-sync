import { isRetryableState, transitionMutationState } from './stateMachine';
import { failSyncMutations, partitionSyncMutations, settleSyncMutations } from './mutationSettlement';
import type { SyncMutation } from './types';

describe('mutation state machine', () => {
  it('moves a queued mutation into syncing and then acked', () => {
    let state = 'PENDING';
    state = transitionMutationState(state, 'CLAIMED');
    expect(state).toBe('SYNCING');

    state = transitionMutationState(state, 'ACKED');
    expect(state).toBe('ACKED');
  });

  it('retries failed mutations and recovers them to pending', () => {
    let state = 'FAILED';
    state = transitionMutationState(state, 'RETRY');
    expect(state).toBe('PENDING');

    state = transitionMutationState(state, 'CLAIMED');
    expect(state).toBe('SYNCING');
  });

  it('treats failed and pending states as retryable', () => {
    expect(isRetryableState('PENDING')).toBe(true);
    expect(isRetryableState('FAILED')).toBe(true);
    expect(isRetryableState('SYNCING')).toBe(false);
    expect(isRetryableState('ACKED')).toBe(false);
  });

  it('keeps acked mutations stable across duplicate events', () => {
    let state = 'ACKED';
    state = transitionMutationState(state, 'RETRY');
    expect(state).toBe('ACKED');

    state = transitionMutationState(state, 'FAILED');
    expect(state).toBe('ACKED');
  });

  it('runs the queued → syncing → network failure → retry → ack lifecycle', () => {
    const mutation: SyncMutation = {
      id: 'mutation-1',
      tableName: 'todos',
      operation: 'CREATE',
      payload: { id: 'todo-1', title: 'offline' },
      timestamp: 1,
    };
    let state = 'PENDING';
    const retried: string[] = [];
    const removed: string[] = [];

    state = transitionMutationState(state, 'CLAIMED');
    expect(state).toBe('SYNCING');

    try {
      throw new Error('network unavailable');
    } catch {
      failSyncMutations([mutation], (failedMutation, nextState) => {
        retried.push(failedMutation.id);
        state = nextState;
      });
    }
    expect(state).toBe('FAILED');
    expect(retried).toEqual(['mutation-1']);

    state = transitionMutationState(state, 'RETRY');
    state = transitionMutationState(state, 'CLAIMED');
    expect(state).toBe('SYNCING');

    const settlement = partitionSyncMutations([mutation], ['mutation-1']);
    settleSyncMutations(settlement, {
      acknowledge: (id, nextState) => {
        removed.push(id.id);
        state = nextState;
      },
      retry: (retriedMutation, nextState) => {
        retried.push(retriedMutation.id);
        state = nextState;
      },
      reject: () => {
        throw new Error('unexpected rejection');
      },
    });

    expect(state).toBe('ACKED');
    expect(removed).toEqual(['mutation-1']);
    expect(retried).toEqual(['mutation-1']);
  });

  it('does not accept acknowledgements for mutations outside the claimed batch', () => {
    const mutation: SyncMutation = {
      id: 'claimed-1',
      tableName: 'todos',
      operation: 'UPDATE',
      payload: { id: 'todo-1' },
      timestamp: 1,
    };

    expect(partitionSyncMutations([mutation], ['other-mutation'])).toEqual({
      acknowledged: [],
      unacknowledged: [mutation],
      rejected: [],
    });
  });

  it('stores permanent rejections separately and does not make them automatically retryable', () => {
    let state = transitionMutationState('SYNCING', 'REJECTED');
    expect(state).toBe('REJECTED');
    expect(isRetryableState(state)).toBe(false);
    expect(transitionMutationState(state, 'RETRY')).toBe('REJECTED');

    state = transitionMutationState(state, 'ACKED');
    expect(state).toBe('ACKED');
  });

  it('separates permanent rejections from retryable server rejections', () => {
    const mutations: SyncMutation[] = [{
      id: 'permanent',
      tableName: 'todos',
      operation: 'CREATE',
      payload: { id: 'todo-4' },
      timestamp: 2,
    }, {
      id: 'temporary',
      tableName: 'todos',
      operation: 'UPDATE',
      payload: { id: 'todo-5' },
      timestamp: 3,
    }];
    const settlement = partitionSyncMutations(mutations, [], [
      { mutationId: 'permanent', code: 'validation', retryable: false },
      { mutationId: 'temporary', code: 'rate_limit', retryable: true },
      { mutationId: 'not-in-batch', code: 'unknown', retryable: false },
    ]);

    expect(settlement.rejected.map((mutation) => mutation.id)).toEqual(['permanent']);
    expect(settlement.unacknowledged.map((mutation) => mutation.id)).toEqual(['temporary']);
  });
});
