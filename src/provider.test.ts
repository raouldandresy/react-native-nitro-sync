import { runSyncTableWorkers } from './tableWorkers';

describe('runSyncTableWorkers', () => {
  it('routes each table once and respects the configured concurrency limit', async () => {
    const started: string[] = [];
    const completed: string[] = [];
    let active = 0;
    let maximumActive = 0;

    const errors = await runSyncTableWorkers(
      ['todos', 'notes', 'projects', 'labels'],
      2,
      async (tableName) => {
        started.push(tableName);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        completed.push(tableName);
        return null;
      },
    );

    expect(errors).toEqual([]);
    expect(started.sort()).toEqual(['labels', 'notes', 'projects', 'todos']);
    expect(completed.sort()).toEqual(started);
    expect(maximumActive).toBe(2);
  });

  it('continues processing successful tables when one table fails', async () => {
    const processed: string[] = [];
    const errors = await runSyncTableWorkers(
      ['todos', 'notes', 'projects'],
      2,
      async (tableName) => {
        processed.push(tableName);
        return tableName === 'notes' ? new Error('notes unavailable') : null;
      },
    );

    expect(processed.sort()).toEqual(['notes', 'projects', 'todos']);
    expect(errors.map((error) => error.message)).toEqual(['notes unavailable']);
  });

  it('rejects an invalid concurrency limit', async () => {
    await expect(runSyncTableWorkers([], 0, async () => null))
      .rejects.toThrow('maxConcurrentTables must be a positive safe integer');
  });
});
