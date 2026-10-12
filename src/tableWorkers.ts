export async function runSyncTableWorkers(
  tables: readonly string[],
  concurrency: number,
  processTable: (tableName: string) => Promise<Error | null>,
): Promise<readonly Error[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new Error('maxConcurrentTables must be a positive safe integer');
  }

  const errors: Error[] = [];
  let nextTableIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const tableIndex = nextTableIndex;
      nextTableIndex += 1;
      if (tableIndex >= tables.length) return;
      const tableError = await processTable(tables[tableIndex]);
      if (tableError !== null) {
        errors.push(tableError);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, tables.length) }, () => worker()),
  );
  return errors;
}
