import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { backfillHistory } from '../src/admin/backfill-history.js';

const id = 'pln-00000000-0000-4000-8000-000000000001';
const record = {
  PK: 'OWNER#alice',
  SK: `PLAN#${id}`,
  kind: 'plan',
  ownerId: 'alice',
  id,
  createdAt: '2026-09-07T12:00:00.000Z',
  status: 'QUEUED',
  digest: 'unchanged',
};

describe('Migração de histórico', () => {
  it('simula por padrão sem gravações e só consulta a partição do proprietário', async () => {
    const commands: unknown[] = [];
    const result = await backfillHistory({
      tableName: 'table',
      ownerId: 'alice',
      write: false,
      client: {
        send: async (command: unknown) => {
          commands.push(command);
          return { Items: [record] };
        },
      },
    });
    expect(result).toEqual({ dryRun: true, examined: 1, updated: 1, unchanged: 0 });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(QueryCommand);
    expect((commands[0] as QueryCommand).input).toMatchObject({
      ExpressionAttributeValues: { ':owner': 'OWNER#alice' },
      ConsistentRead: true,
    });
  });

  it('é retomável/idempotente e preserva estado, digest e revisão concorrentes', async () => {
    const commands: unknown[] = [];
    const client = {
      send: async (command: unknown) => {
        commands.push(command);
        return command instanceof QueryCommand
          ? { Items: [record], LastEvaluatedKey: { PK: record.PK, SK: record.SK } }
          : {};
      },
    };
    const result = await backfillHistory({
      tableName: 'table',
      ownerId: 'alice',
      write: true,
      maxPages: 1,
      client,
    });
    expect(result.nextAfter).toBe(record.SK);
    const update = commands.find((command) => command instanceof UpdateCommand) as UpdateCommand;
    expect(update.input.UpdateExpression).toBe(
      'SET #timelinePK = :timelinePK, #timelineSK = :timelineSK',
    );
    expect(update.input.ExpressionAttributeValues).toMatchObject({
      ':timelinePK': 'OWNER#alice#plan',
      ':timelineSK': `${record.createdAt}#${id}`,
    });
    const repeat = await backfillHistory({
      tableName: 'table',
      ownerId: 'alice',
      write: true,
      client: {
        send: async (command: unknown) => {
          if (!(command instanceof QueryCommand))
            throw new Error('Replay tentou atualizar novamente.');
          return {
            Items: [
              {
                ...record,
                timelinePK: 'OWNER#alice#plan',
                timelineSK: `${record.createdAt}#${id}`,
              },
            ],
          };
        },
      },
    });
    expect(repeat).toMatchObject({ updated: 0, unchanged: 1 });
  });

  it('não grava registro ou cursor fora do proprietário esperado', async () => {
    let writes = 0;
    await expect(
      backfillHistory({
        tableName: 'table',
        ownerId: 'alice',
        write: true,
        client: {
          send: async (command: unknown) => {
            if (command instanceof UpdateCommand) writes += 1;
            return { Items: [{ ...record, PK: 'OWNER#bob', ownerId: 'bob' }] };
          },
        },
      }),
    ).rejects.toThrow('Registro incompatível');
    expect(writes).toBe(0);
    await expect(
      backfillHistory({
        tableName: 'table',
        ownerId: 'alice',
        write: false,
        client: {
          send: async () => ({ Items: [], LastEvaluatedKey: { PK: 'OWNER#bob', SK: record.SK } }),
        },
      }),
    ).rejects.toThrow('Paginação');
  });
});
