import { describe, expect, it } from 'vitest';

import { MemoryRepository } from '../src/adapters/memory.js';
import { SqliteRepository } from '../src/adapters/sqlite.js';
import type { Plan, Principal, Repository } from '../src/domain/contracts.js';
import { listOperations, listPlans } from '../src/domain/history.js';
import { planDigest } from '../src/domain/repository-rules.js';

const reader: Principal = { ownerId: 'owner-a', scopes: ['architecture:read'] };

function plan(id: string, createdAt: string, ownerId = reader.ownerId): Plan {
  const value: Plan = {
    id,
    ownerId,
    digest: '',
    createdAt,
    expiresAt: '2026-09-08T00:00:00.000Z',
    input: { name: 'history-data', blueprint: 'storage', environment: 'dev' },
    region: 'us-east-1',
    stackName: `camcp-${id}`,
    template: { Resources: { PrivateData: { Type: 'AWS::S3::Bucket' } } },
    summary: [id],
    status: 'PLANNED',
  };
  return { ...value, digest: planDigest(value) };
}

async function seed(repository: Repository): Promise<void> {
  await repository.putPlan(plan('pln-a', '2026-09-07T12:00:00.000Z'));
  await repository.putPlan(plan('pln-b', '2026-09-07T12:00:00.000Z'));
  await repository.putPlan(plan('pln-c', '2026-09-07T11:00:00.000Z'));
  await repository.putPlan(plan('pln-private', '2026-09-07T13:00:00.000Z', 'owner-b'));
}

function historySuite(
  name: string,
  factory: () => Repository,
  close?: (repository: Repository) => void,
) {
  describe(name, () => {
    it('pagina em ordem decrescente, desempata pelo id e não se desloca por item novo', async () => {
      const repository = factory();
      try {
        await seed(repository);
        const first = await listPlans(repository, reader, { limit: 1 });
        expect(first.items.map((item) => item.id)).toEqual(['pln-b']);
        expect(first.nextCursor).toEqual(expect.any(String));
        expect(first.items[0]).not.toHaveProperty('template');
        expect(first.items[0]).not.toHaveProperty('ownerId');

        await repository.putPlan(plan('pln-new', '2026-09-07T14:00:00.000Z'));
        const second = await listPlans(repository, reader, { limit: 2, cursor: first.nextCursor });
        expect(second.items.map((item) => item.id)).toEqual(['pln-a', 'pln-c']);
        expect(second.nextCursor).toBeUndefined();
      } finally {
        close?.(repository);
      }
    });

    it('rejeita cursores e limites inválidos, outro dono e outro tipo de histórico', async () => {
      const repository = factory();
      try {
        await seed(repository);
        const first = await listPlans(repository, reader, { limit: 1 });
        await expect(
          listPlans(repository, reader, { cursor: 'not-a-cursor' }),
        ).rejects.toMatchObject({
          code: 'INVALID_INPUT',
        });
        await expect(listPlans(repository, reader, { limit: 0 })).rejects.toMatchObject({
          code: 'INVALID_INPUT',
        });
        await expect(listPlans(repository, reader, { limit: 51 })).rejects.toMatchObject({
          code: 'INVALID_INPUT',
        });
        await expect(
          listPlans(repository, { ...reader, ownerId: 'owner-b' }, { cursor: first.nextCursor }),
        ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        await expect(
          listOperations(repository, reader, { cursor: first.nextCursor }),
        ).rejects.toMatchObject({
          code: 'INVALID_INPUT',
        });
        await expect(
          listPlans(repository, { ownerId: reader.ownerId, scopes: [] }, {}),
        ).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
      } finally {
        close?.(repository);
      }
    });

    it('lista o plano aprovado com estado atual', async () => {
      const repository = factory();
      try {
        const approved = plan('pln-approved', '2026-09-07T12:00:00.000Z');
        await repository.putPlan(approved);
        await repository.approvePlan(
          reader.ownerId,
          approved.id,
          approved.digest,
          'operator',
          '2026-09-07T12:01:00.000Z',
        );
        const page = await listPlans(repository, reader, {});
        expect(page.items).toMatchObject([
          { id: approved.id, status: 'APPROVED', approvedBy: 'operator' },
        ]);
      } finally {
        close?.(repository);
      }
    });

    it('resume operações sem outputs nem identificador do proprietário', async () => {
      const repository = factory();
      try {
        const approved = plan('pln-operation', '2026-09-07T12:00:00.000Z');
        await repository.putPlan(approved);
        await repository.approvePlan(
          reader.ownerId,
          approved.id,
          approved.digest,
          'operator',
          '2026-09-07T12:01:00.000Z',
        );
        const operation = await repository.enqueueOperation(
          reader.ownerId,
          approved.id,
          approved.digest,
          'history-operation',
          '2026-09-07T12:02:00.000Z',
        );
        await repository.updateOperation(reader.ownerId, operation.id, {
          status: 'RUNNING',
          updatedAt: '2026-09-07T12:03:00.000Z',
          outputs: { ignored: 'outside history response' },
        });
        const page = await listOperations(repository, reader, {});
        expect(page.items).toMatchObject([{ id: operation.id, status: 'RUNNING' }]);
        expect(page.items[0]).not.toHaveProperty('outputs');
        expect(page.items[0]).not.toHaveProperty('ownerId');
      } finally {
        close?.(repository);
      }
    });
  });
}

historySuite('Histórico em memória', () => new MemoryRepository());
historySuite(
  'Histórico SQLite real',
  () => new SqliteRepository(':memory:'),
  (repository) => {
    (repository as SqliteRepository).close();
  },
);
