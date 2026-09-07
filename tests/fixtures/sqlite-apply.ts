import { SqliteRepository } from '../../src/adapters/sqlite.js';

process.once(
  'message',
  async (data: { path: string; owner: string; planId: string; digest: string; key: string }) => {
    const repository = new SqliteRepository(data.path);
    try {
      const operation = await repository.enqueueOperation(
        data.owner,
        data.planId,
        data.digest,
        data.key,
        new Date().toISOString(),
      );
      process.send?.({ id: operation.id });
    } catch (error) {
      process.send?.({ error: error instanceof Error ? error.message : 'Unknown' });
      process.exitCode = 1;
    } finally {
      repository.close();
      process.disconnect();
    }
  },
);
process.send?.({ ready: true });
