import type { SyncMutationEvent, SyncMutationStatus } from './types';

export function transitionMutationState(
  current: SyncMutationStatus,
  event: SyncMutationEvent,
): SyncMutationStatus {
  switch (current) {
    case 'PENDING':
      switch (event) {
        case 'CLAIMED':
          return 'SYNCING';
        case 'FAILED':
          return 'FAILED';
        case 'REJECTED':
          return 'REJECTED';
        case 'RECOVERED':
          return 'PENDING';
        case 'ACKED':
          return 'ACKED';
        case 'ENQUEUED':
        case 'RETRY':
          return 'PENDING';
      }
      break;
    case 'SYNCING':
      switch (event) {
        case 'ACKED':
          return 'ACKED';
        case 'FAILED':
          return 'FAILED';
        case 'REJECTED':
          return 'REJECTED';
        case 'RETRY':
        case 'RECOVERED':
          return 'PENDING';
        case 'CLAIMED':
        case 'ENQUEUED':
          return 'SYNCING';
      }
      break;
    case 'FAILED':
      switch (event) {
        case 'RETRY':
        case 'RECOVERED':
          return 'PENDING';
        case 'CLAIMED':
          return 'SYNCING';
        case 'ACKED':
          return 'ACKED';
        case 'ENQUEUED':
        case 'FAILED':
          return 'FAILED';
        case 'REJECTED':
          return 'REJECTED';
      }
      break;
    case 'ACKED':
      switch (event) {
        case 'ENQUEUED':
        case 'CLAIMED':
        case 'FAILED':
        case 'RETRY':
        case 'RECOVERED':
          return 'ACKED';
        case 'ACKED':
          return 'ACKED';
      }
      break;
    case 'REJECTED':
      switch (event) {
        case 'ENQUEUED':
        case 'CLAIMED':
        case 'ACKED':
        case 'RETRY':
        case 'FAILED':
        case 'RECOVERED':
        case 'REJECTED':
          return event === 'ACKED' ? 'ACKED' : 'REJECTED';
      }
      break;
  }

  return current;
}

export function isRetryableState(state: SyncMutationStatus): boolean {
  return state === 'FAILED' || state === 'PENDING';
}
