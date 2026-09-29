import { mergePulledRecords, parseSerializedMutation, recordIdFromPayload } from './merge';
import type { SyncMutation, SyncRecord } from './types';

describe('recordIdFromPayload', () => {
  it('prefers the record id over a mutation id', () => {
    expect(recordIdFromPayload({ id: 'record-1' }, 'mutation-1')).toBe('record-1');
  });
});

describe('parseSerializedMutation', () => {
  it('preserves schema versions from native queue batches and defaults legacy rows to version one', () => {
    const base = {
      id: 'mutation-1',
      tableName: 'todos',
      operation: 'UPDATE',
      payload: JSON.stringify({ id: 'todo-1' }),
      timestamp: 12,
    };

    expect(parseSerializedMutation(JSON.stringify({ ...base, schemaVersion: 7 })).schemaVersion).toBe(7);
    expect(parseSerializedMutation(JSON.stringify(base)).schemaVersion).toBe(1);
  });
});

describe('mergePulledRecords', () => {
  const local: SyncRecord[] = [
    { id: 'keep-pending', title: 'local' },
    { id: 'lww-remote', title: 'old', updatedAt: 1 },
    { id: 'local-only', title: 'only here' },
  ];
  const remote: SyncRecord[] = [
    { id: 'keep-pending', title: 'server' },
    { id: 'lww-remote', title: 'new', updatedAt: 2 },
    { id: 'server-only', title: 'from server' },
  ];
  const unacked: SyncMutation[] = [{
    id: 'mut-1',
    tableName: 'todos',
    operation: 'UPDATE',
    payload: { id: 'keep-pending', title: 'local' },
    timestamp: 10,
  }];

  it('keeps optimistic local rows that still have unacked mutations', () => {
    const merged = mergePulledRecords(local, remote, unacked);
    expect(merged.find((record) => record.id === 'keep-pending')?.title).toBe('local');
  });

  it('applies last-write-wins when there is no pending mutation', () => {
    const merged = mergePulledRecords(local, remote, unacked);
    expect(merged.find((record) => record.id === 'lww-remote')?.title).toBe('new');
  });

  it('supports server-wins conflict resolution', () => {
    const merged = mergePulledRecords(local, remote, [], 'server-wins');
    expect(merged.find((record) => record.id === 'local-only')?.title).toBe('only here');
    expect(merged.find((record) => record.id === 'lww-remote')?.title).toBe('new');
  });

  it('supports client-wins conflict resolution', () => {
    const merged = mergePulledRecords(
      [{ id: 'record-1', title: 'local', updatedAt: 4 }],
      [{ id: 'record-1', title: 'remote', updatedAt: 10 }],
      [],
      'client-wins',
    );
    expect(merged).toEqual([{ id: 'record-1', title: 'local', updatedAt: 4 }]);
  });

  it('supports field merge conflict resolution', () => {
    const merged = mergePulledRecords(
      [{
        id: 'record-2',
        title: 'local title',
        completed: false,
        profile: { localOnly: 'keep', shared: 'local', settings: { local: true } },
        updatedAt: 1,
      }],
      [{
        id: 'record-2',
        title: 'remote title',
        completed: true,
        profile: { remoteOnly: 'add', shared: 'remote', settings: { remote: true } },
        updatedAt: 2,
      }],
      [],
      'merge-fields',
    );
    expect(merged).toEqual([
      {
        id: 'record-2',
        title: 'remote title',
        completed: true,
        profile: {
          localOnly: 'keep',
          remoteOnly: 'add',
          shared: 'remote',
          settings: { local: true, remote: true },
        },
        updatedAt: 2,
      },
    ]);
  });

  it('supports custom conflict resolvers', () => {
    const merged = mergePulledRecords(
      [{ id: 'record-3', title: 'local', updatedAt: 3 }],
      [{ id: 'record-3', title: 'remote', updatedAt: 5 }],
      [],
      (local, remote) => ({ ...local, title: `${local.title}|${remote.title}` }),
    );
    expect(merged[0].title).toBe('local|remote');
  });

  it('rejects custom resolvers that change record identity', () => {
    expect(() => mergePulledRecords(
      [{ id: 'record-4', title: 'local' }],
      [{ id: 'record-4', title: 'remote' }],
      [],
      (_local, remote) => ({ ...remote, id: 'different-id' }),
    )).toThrow('Conflict resolver changed immutable record ID');
  });

  it('does not drop local-only rows during an incremental pull', () => {
    const merged = mergePulledRecords(local, remote, unacked);
    expect(merged.map((record) => record.id).sort()).toEqual([
      'keep-pending',
      'local-only',
      'lww-remote',
      'server-only',
    ]);
  });

  it('does not resurrect records from a pull older than a local tombstone', () => {
    const merged = mergePulledRecords(
      [],
      [{ id: 'deleted-1', title: 'stale server row', updatedAt: 8 }],
      [],
      'last-write-wins',
      [{ id: 'deleted-1', timestamp: 9 }],
    );
    expect(merged).toEqual([]);
  });

  it('allows a strictly newer server revision to restore a tombstoned record', () => {
    const merged = mergePulledRecords(
      [],
      [{ id: 'restored-1', title: 'new server row', updatedAt: 10 }],
      [],
      'last-write-wins',
      [{ id: 'restored-1', timestamp: 9 }],
    );
    expect(merged).toEqual([
      { id: 'restored-1', title: 'new server row', updatedAt: 10 },
    ]);
  });

  it('keeps tombstoned records hidden when the pulled row has no revision timestamp', () => {
    const merged = mergePulledRecords(
      [],
      [{ id: 'deleted-2', title: 'unversioned server row' }],
      [],
      'last-write-wins',
      [{ id: 'deleted-2', timestamp: 9 }],
    );
    expect(merged).toEqual([]);
  });

  it('removes a local record when an authoritative newer server tombstone is pulled', () => {
    const merged = mergePulledRecords(
      [{ id: 'deleted-local', title: 'local copy', updatedAt: 8 }],
      [],
      [],
      'last-write-wins',
      [{ id: 'deleted-local', timestamp: 9 }],
    );
    expect(merged).toEqual([]);
  });
});
