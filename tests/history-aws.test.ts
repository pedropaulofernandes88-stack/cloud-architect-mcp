import { BatchGetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';

import { DynamoRepository } from '../src/adapters/dynamodb.js';
import type { Plan, Principal } from '../src/domain/contracts.js';
import { listPlans } from '../src/domain/history.js';
import { planDigest } from '../src/domain/repository-rules.js';

const principal: Principal = { ownerId: 'owner', scopes: ['architecture:read'] };

function plan(id: string, createdAt: string, status: Plan['status'] = 'PLANNED'): Plan {
  const value: Plan = {
    id,
    ownerId: principal.ownerId,
    digest: '',
    createdAt,
    expiresAt: '2026-09-08T00:00:00.000Z',
    input: { name: 'history-data', blueprint: 'storage', environment: 'dev' },
    region: 'us-east-1',
    stackName: `camcp-${id}`,
    template: { Resources: {} },
    summary: [],
    status,
  };
  return { ...value, digest: planDigest(value) };
}

function timeline(planValue: Plan) {
  return {
    PK: 'OWNER#owner',
    SK: `PLAN#${planValue.id}`,
    timelinePK: 'OWNER#owner#plan',
    timelineSK: `${planValue.createdAt}#${planValue.id}`,
  };
}

describe('Histórico DynamoDB', () => {
  it('consulta somente a GSI Timeline e hidrata o estado atual por BatchGet consistente', async () => {
    const newest = plan('pln-newest', '2026-09-07T12:00:00.000Z');
    const older = plan('pln-older', '2026-09-07T11:00:00.000Z', 'QUEUED');
    const commands: unknown[] = [];
    let batch = 0;
    const repository = new DynamoRepository({
      tableName: 'operations',
      client: {
        send: async (command: unknown) => {
          commands.push(command);
          if (command instanceof QueryCommand)
            return { Items: [timeline(newest), timeline(older)] };
          if (command instanceof BatchGetCommand) {
            batch += 1;
            return batch === 1
              ? {
                  Responses: {
                    operations: [
                      { ...older, ...timeline(older), kind: 'plan' },
                      { ...newest, ...timeline(newest), kind: 'plan' },
                    ],
                  },
                }
              : {
                  Responses: {
                    operations: [
                      {
                        PK: 'APPROVAL#owner',
                        SK: `PLAN#${newest.id}`,
                        kind: 'approval',
                        planId: newest.id,
                        digest: newest.digest,
                        approvedAt: '2026-09-07T12:01:00.000Z',
                        approvedBy: 'operator',
                      },
                    ],
                  },
                };
          }
          throw new Error('Comando inesperado');
        },
      },
    });

    const result = await listPlans(repository, principal, { limit: 1 });
    expect(result.items).toMatchObject([
      { id: newest.id, status: 'APPROVED', approvedBy: 'operator' },
    ]);
    expect(result.items[0]).not.toHaveProperty('template');
    expect(result.nextCursor).toEqual(expect.any(String));
    const query = commands.find((command) => command instanceof QueryCommand) as QueryCommand;
    expect(query.input).toMatchObject({
      TableName: 'operations',
      IndexName: 'Timeline',
      ScanIndexForward: false,
      Limit: 2,
      ExpressionAttributeValues: { ':pk': 'OWNER#owner#plan' },
    });
    const batches = commands.filter(
      (command) => command instanceof BatchGetCommand,
    ) as BatchGetCommand[];
    expect(batches).toHaveLength(2);
    expect(batches[0]?.input.RequestItems?.operations?.ConsistentRead).toBe(true);
    expect(
      commands.some(
        (command) =>
          typeof command === 'object' &&
          command !== null &&
          'constructor' in command &&
          command.constructor.name === 'ScanCommand',
      ),
    ).toBe(false);
  });

  it('falha se o BatchGet deixar itens não processados após três tentativas', async () => {
    const current = plan('pln-newest', '2026-09-07T12:00:00.000Z');
    const waits: number[] = [];
    const repository = new DynamoRepository({
      tableName: 'operations',
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
      random: () => 0,
      client: {
        send: async (command: unknown) => {
          if (command instanceof QueryCommand) return { Items: [timeline(current)] };
          if (command instanceof BatchGetCommand)
            return {
              Responses: { operations: [] },
              UnprocessedKeys: {
                operations: { Keys: [{ PK: 'OWNER#owner', SK: `PLAN#${current.id}` }] },
              },
            };
          throw new Error('Comando inesperado');
        },
      },
    });
    await expect(listPlans(repository, principal, {})).rejects.toThrow(
      'DynamoDB não processou todos os itens do histórico.',
    );
    expect(waits).toEqual([10, 20]);
  });

  it('aguarda um backoff limitado antes de repetir itens não processados', async () => {
    const current = plan('pln-newest', '2026-09-07T12:00:00.000Z');
    const waits: number[] = [];
    let batches = 0;
    const repository = new DynamoRepository({
      tableName: 'operations',
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
      random: () => 0,
      client: {
        send: async (command: unknown) => {
          if (command instanceof QueryCommand) return { Items: [timeline(current)] };
          if (command instanceof BatchGetCommand) {
            batches += 1;
            if (batches === 1)
              return {
                Responses: { operations: [] },
                UnprocessedKeys: {
                  operations: { Keys: [{ PK: 'OWNER#owner', SK: `PLAN#${current.id}` }] },
                },
              };
            if (batches === 2)
              return {
                Responses: { operations: [{ ...current, ...timeline(current), kind: 'plan' }] },
              };
            return { Responses: { operations: [] } };
          }
          throw new Error('Comando inesperado');
        },
      },
    });

    await expect(listPlans(repository, principal, {})).resolves.toMatchObject({
      items: [{ id: current.id, status: 'PLANNED' }],
    });
    expect(waits).toEqual([10]);
  });

  it('falha claramente em vez de ocultar item Timeline inconsistente', async () => {
    const current = plan('pln-newest', '2026-09-07T12:00:00.000Z');
    const repository = new DynamoRepository({
      tableName: 'operations',
      client: {
        send: async (command: unknown) => {
          if (command instanceof QueryCommand)
            return { Items: [{ ...timeline(current), PK: 'OWNER#other' }] };
          throw new Error('BatchGet não deveria ser chamado');
        },
      },
    });

    await expect(listPlans(repository, principal, {})).rejects.toThrow(
      'Índice Timeline contém um item inconsistente.',
    );
  });
});
